import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from 'pg';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresStore } from '../server/persistence/postgres.js';
import { importLegacyDirectory, readLegacyDirectory } from '../server/persistence/import-json.js';
import { AccountService } from '../server/accounts.js';
import { CareerService } from '../server/career.js';
import { emptyProfile } from '../server/persistence/career-profile.js';
import { GameEngine } from '../server/game.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { postgresFixture } from './lib/postgres-fixture.mjs';
import { testRewardDurability } from './lib/postgres-reward-contracts.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-postgres-contracts-'));
const legacy = path.join(directory, 'legacy');
const runtimeDirectory = path.join(directory, 'must-not-be-written');
const password = 'Database integration password 123';
const guest = 'a'.repeat(64), claimedGuest = 'b'.repeat(64);
const seeded = { ...emptyProfile(), xp: 900, credits: 500, kills: 7, matches: 2 };
let fixture, store, server, admin, legacyHttp, legacyAccounts, base;

class Browser {
  constructor(cookie = '') {
    this.cookies = new Map(cookie.split(';').filter(Boolean).map(value => {
      const at = value.indexOf('='); return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
    }));
  }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(route, body = undefined) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.cookie, Origin: base, 'Content-Type': 'application/json', 'X-VB-Account': '1', 'X-VB-Career': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1);
      if (!value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return { status: response.status, headers: response.headers, value: await response.json() };
  }
  async ok(route, body) {
    const result = await this.request(route, body);
    assert.ok(result.status >= 200 && result.status < 300, `${route}: ${result.status} ${JSON.stringify(result.value)}`);
    return result.value;
  }
}

async function launch() {
  server = startServer({ env: { DATABASE_URL: fixture.connectionString, VB_PERSISTENCE: 'postgres', VB_DATA_DIR: runtimeDirectory },
    failureContext: 'PostgreSQL HTTP runtime', stopTimeout: 15000 });
  base = `http://127.0.0.1:${await server.port}`;
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok', persistence: 'postgres' });
}

async function digestFiles(root) {
  return (await readLegacyDirectory(root)).map(file => [file.path, file.checksum]);
}

try {
  fixture = await postgresFixture();
  console.log('PostgreSQL: isolated real container and named volume ready.');
  await mkdir(path.join(legacy, 'accounts'), { recursive: true });
  legacyAccounts = new AccountService({ directory: path.join(legacy, 'accounts') });
  legacyHttp = http.createServer((req, res) => legacyAccounts.handleHttp(req, res));
  await new Promise(resolve => legacyHttp.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${legacyHttp.address().port}`;
  const importedBrowser = new Browser();
  const importedUser = await importedBrowser.ok('/api/account/register', { username: 'ImportedUser', password });
  const importedKey = `account:${importedUser.user.id}`;
  await importedBrowser.ok('/api/account/login', { username: 'ImportedUser', password });
  legacyAccounts.dispose();
  await new Promise(resolve => legacyHttp.close(resolve)); legacyHttp = null;
  await mkdir(path.join(legacy, 'account-careers'));
  await mkdir(path.join(legacy, 'career-claims'));
  await writeFile(path.join(legacy, guest + '.json'), JSON.stringify(seeded));
  await writeFile(path.join(legacy, claimedGuest + '.json'), JSON.stringify({ ...seeded, xp: 400 }));
  await writeFile(path.join(legacy, 'account-careers', importedUser.user.id + '.json'), JSON.stringify({ ...seeded, credits: 450 }));
  await writeFile(path.join(legacy, 'career-claims', claimedGuest + '.json'), JSON.stringify({ account: importedKey, profile: { ...seeded, xp: 400 } }));
  const sourceHashes = await digestFiles(legacy);

  store = await PostgresStore.open({ connectionString: fixture.connectionString });
  await assert.rejects(PostgresStore.open({ connectionString: fixture.connectionString }), /Another voxel-blitz writer/);
  assert.deepEqual(await importLegacyDirectory(store, legacy), { imported: 5, skipped: 0 });
  assert.deepEqual(await importLegacyDirectory(store, legacy), { imported: 0, skipped: 5 });
  assert.equal((await store.readProfile(importedKey)).xp, 900, 'claim snapshot cannot overwrite a newer account profile');
  assert.equal(await store.readProfile(claimedGuest), null, 'imported claim invalidates the guest token');
  await store.applyProgress(importedKey, { xp: 25, credits: 10, kills: 1 });
  await importLegacyDirectory(store, legacy);
  assert.equal((await store.readProfile(importedKey)).xp, 925, 'repeat import cannot revert post-import progress');
  assert.deepEqual(await digestFiles(legacy), sourceHashes, 'import source bytes are untouched');

  const corrupt = path.join(directory, 'corrupt');
  await mkdir(corrupt);
  await writeFile(path.join(corrupt, 'c'.repeat(64) + '.json'), JSON.stringify(seeded));
  await writeFile(path.join(corrupt, 'd'.repeat(64) + '.json'), '{broken json');
  await assert.rejects(importLegacyDirectory(store, corrupt), /Invalid JSON/);
  assert.equal((await store.transaction(client => client.query('SELECT id FROM vb_careers WHERE id=$1', ['c'.repeat(64)]))).rowCount, 0,
    'one corrupt file prevents the entire import');
  await writeFile(path.join(legacy, guest + '.json'), JSON.stringify({ ...seeded, xp: 9999 }));
  await assert.rejects(importLegacyDirectory(store, legacy), /Previously imported source changed/);
  assert.equal((await store.readProfile(guest)).xp, 900, 'changed source never overwrites a migrated career');
  await writeFile(path.join(legacy, guest + '.json'), JSON.stringify(seeded));

  const accounts = await AccountService.create({ store });
  const career = await CareerService.create({ store, accounts });
  const client = { id: 'reward-player', profileId: guest };
  const engine = new GameEngine({ mode: 'fun', broadcast(snapshot) {
    career.observe(client, snapshot)?.catch(error => { throw error; });
  } });
  client.room = { engine };
  engine.addClient(client.id, 'Player'); engine.addClient('target', 'Target');
  let transactions = 0;
  const originalTransaction = store.transaction.bind(store);
  store.transaction = (...args) => { transactions++; return originalTransaction(...args); };
  for (let tick = 0; tick < 100; tick++) engine.step();
  assert.equal(transactions, 0, 'idle 20 Hz snapshots perform no database operations');
  engine.killPlayer(engine.entities.get('target'), engine.entities.get(client.id), 'rifle', false);
  engine.step();
  await career.flush();
  assert.equal(transactions, 1, 'one real authoritative kill writes one reward transaction');
  assert.equal((await career.readProfile(guest)).xp, 925);
  assert.equal((await career.readProfile(guest)).credits, 510);
  store.transaction = originalTransaction;
  engine.stop(); await accounts.dispose(); await career.dispose();
  await store.close(); store = null;
  console.log('PostgreSQL: writer exclusion, source-preserving idempotent import, corrupt-source rejection and event-only durable rewards passed.');

  await launch();
  const oldAccount = await importedBrowser.ok('/api/account');
  assert.equal(oldAccount.user.id, importedUser.user.id, 'imported hashed session remains valid');
  assert.equal((await importedBrowser.ok('/api/career')).xp, 925);
  const candidates = [new Browser(`vb-career=${guest}`), new Browser(`vb-career=${guest}`)];
  const registrations = await Promise.all(candidates.map((browser, index) => browser.ok('/api/account/register', {
    username: `Concurrent_${index}`, password,
  })));
  const profiles = await Promise.all(candidates.map(browser => browser.ok('/api/career')));
  assert.deepEqual(profiles.map(profile => profile.xp).sort((a,b)=>a-b), [0, 925], 'exactly one account adopts the guest career');
  const ownerIndex = profiles.findIndex(profile => profile.xp === 925);
  const owner = candidates[ownerIndex], ownerUser = registrations[ownerIndex].user;
  const otherDevice = new Browser();
  await otherDevice.ok('/api/account/login', { username: ownerUser.username, password });
  const duplicateBuys = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? owner : otherDevice).request('/api/career/purchase', { item: 'arctic' })));
  assert.ok(duplicateBuys.every(response => response.status === 200));
  assert.equal((await owner.ok('/api/career')).credits, 410, 'concurrent duplicate purchases charge once');
  const differentBuys = await Promise.all([
    owner.request('/api/career/purchase', { item: 'orchid' }),
    otherDevice.request('/api/career/purchase', { item: 'mint' }),
  ]);
  assert.deepEqual(differentBuys.map(result => result.status).sort(), [200, 400], 'concurrent purchases cannot overspend shared credits');
  const purchased = await owner.ok('/api/career');
  assert.ok([160, 10].includes(purchased.credits));
  assert.deepEqual(await otherDevice.ok('/api/career'), purchased, 'both devices see committed shared ownership');
  assert.equal((await new Browser(`vb-career=${guest}`).ok('/api/career')).xp, 0, 'claimed guest cookie cannot access transferred funds');

  admin = new Client({ connectionString: fixture.connectionString }); await admin.connect();
  const ownerId = `account:${ownerUser.id}`;
  await admin.query('ALTER TABLE vb_sessions ADD CONSTRAINT test_reject_sessions CHECK (expires_at_ms < created_at_ms) NOT VALID');
  const sessionsBefore = await admin.query('SELECT * FROM vb_sessions ORDER BY hash');
  const failedLogin = await owner.request('/api/account/login', { username: ownerUser.username, password });
  assert.equal(failedLogin.status, 503); assert.equal(failedLogin.headers.get('set-cookie'), null);
  assert.deepEqual((await admin.query('SELECT * FROM vb_sessions ORDER BY hash')).rows, sessionsBefore.rows, 'failed session replacement rolls back old-session deletion');
  assert.equal((await owner.ok('/api/account')).user.id, ownerUser.id, 'failed auth write leaves existing cookie/cache valid');
  const rejectedUser = await new Browser().request('/api/account/register', { username: 'RejectedWrite', password });
  assert.equal(rejectedUser.status, 503);
  assert.equal((await admin.query('SELECT id FROM vb_accounts WHERE username_key=$1', ['rejectedwrite'])).rowCount, 0, 'account and session registration roll back together');
  await admin.query('ALTER TABLE vb_sessions DROP CONSTRAINT test_reject_sessions');

  const beforeFailure = await owner.ok('/api/career');
  await admin.query("ALTER TABLE vb_careers ADD CONSTRAINT test_reject_purchase CHECK (equipped->>'theme' <> 'amber') NOT VALID");
  const failedPurchase = await owner.request('/api/career/purchase', { item: 'amber', equipOnly: true });
  assert.notEqual(failedPurchase.status, 200);
  assert.deepEqual(await owner.ok('/api/career'), beforeFailure, 'failed career write cannot charge or equip an item');
  await admin.query('ALTER TABLE vb_careers DROP CONSTRAINT test_reject_purchase');
  await admin.query('UPDATE vb_careers SET owned=$2 WHERE id=$1', [ownerId, '[]']);
  assert.equal((await owner.request('/api/career')).status, 503, 'damaged database profile returns unavailable instead of zero XP');
  assert.equal((await admin.query('SELECT xp FROM vb_careers WHERE id=$1', [ownerId])).rows[0].xp, '925');
  await admin.query('UPDATE vb_careers SET owned=$2 WHERE id=$1', [ownerId, JSON.stringify(beforeFailure.owned)]);
  await admin.end(); admin = null;
  await assert.rejects(access(runtimeDirectory), { code: 'ENOENT' }, 'PostgreSQL runtime creates no JSON primary store');
  console.log('PostgreSQL: actual HTTP registration/login, two-device careers, atomic guest claim, parallel purchases and rollback/error boundaries passed.');

  const afterWrites = await owner.ok('/api/career');
  server.stopping = true;
  server.child.kill('SIGKILL'); await server.exit; server = null;
  await fixture.restart();
  await launch();
  assert.equal((await owner.ok('/api/account')).user.id, ownerUser.id, 'session survives app kill and PostgreSQL restart');
  assert.deepEqual(await owner.ok('/api/career'), afterWrites, 'committed career and cosmetics survive database restart');
  assert.deepEqual(await otherDevice.ok('/api/career'), afterWrites, 'second-device session also survives restart');
  await otherDevice.ok('/api/account/password', { currentPassword: password, newPassword: password + ' changed' });
  assert.equal((await owner.ok('/api/account')).user, null, 'password change revokes other device after database commit');
  await stopServer(server); server = null;
  await launch();
  assert.equal((await owner.ok('/api/account')).user, null, 'session revocation survives restart');
  assert.equal((await otherDevice.ok('/api/account')).user.id, ownerUser.id);
  const recovered = await owner.ok('/api/account/recover', { username: ownerUser.username,
    recoveryCode: registrations[ownerIndex].recoveryCode, newPassword: password + ' recovered' });
  assert.ok(recovered.recoveryCode);
  assert.equal((await otherDevice.ok('/api/account')).user, null);
  assert.deepEqual(await owner.ok('/api/career'), afterWrites, 'credential recovery preserves career');
  // A broken lease must terminate the cached writer rather than continue with
  // stale sessions or reopen a second connection behind the old process.
  const running = server;
  await fixture.restart();
  const lost = await Promise.race([running.exit, new Promise((_, reject) => setTimeout(() => reject(new Error('writer did not stop on DB lease loss')), 5000))]);
  assert.equal(lost.code, 1); server = null;
  await launch();
  assert.deepEqual(await owner.ok('/api/career'), afterWrites);
  await stopServer(server); server = null;
  store = await PostgresStore.open({ connectionString: fixture.connectionString });
  assert.deepEqual(await importLegacyDirectory(store, legacy), { imported: 0, skipped: 5 });
  assert.equal((await store.readProfile(ownerId)).xp, 925);
  assert.deepEqual(await digestFiles(legacy), sourceHashes);
  await store.close(); store = null;
  await testRewardDurability(fixture.connectionString);
  console.log('POSTGRESQL TESTS: ALL OK (database restart, abrupt app kill, session revocation/recovery and lease-loss fail-closed included).');
} finally {
  await admin?.end().catch(() => {});
  await stopServer(server).catch(() => {});
  await store?.close().catch(() => {});
  legacyAccounts?.dispose();
  if (legacyHttp) await new Promise(resolve => legacyHttp.close(resolve));
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
