import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AccountError } from '../account-security.js';
import { CAREER_CATALOG, careerView } from '../../shared/career.js';
import { CAREER_ID, emptyProfile, validateProfile } from './career-profile.js';

const LOCK = [1447185492, 1];
const RETRYABLE = new Set(['57014', '40001', '40P01', '55P03']);
const profileFromRow = row => validateProfile({ xp: Number(row.xp), credits: Number(row.credits),
  kills: Number(row.kills), matches: Number(row.matches), owned: row.owned, equipped: row.equipped });

/** One connection owns both the writer lease and serialized transactions.
 * Losing it invalidates the auth/claim cache; a new process must reload it.
 * https://node-postgres.com/features/transactions */
export class PostgresStore {
  static async open({ connectionString = process.env.DATABASE_URL, onLost = null } = {}) {
    if (!connectionString) throw new Error('DATABASE_URL is required; use VB_PERSISTENCE=file only for local fixtures');
    const store = new PostgresStore(connectionString, onLost);
    try {
      await store.client.connect();
      const lock = await store.client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', LOCK);
      if (!lock.rows[0].acquired) throw new Error('Another voxel-blitz writer owns this database; stop it before starting or importing');
      store.active = true;
      await store.migrate();
      return store;
    } catch (error) { await store.client.end().catch(() => {}); throw error; }
  }

  constructor(connectionString, onLost) {
    this.client = new Client({ connectionString, application_name: 'voxel-blitz',
      connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000,
      keepAlive: true, keepAliveInitialDelayMillis: 1000 });
    this.active = false;
    this.closing = false;
    this.pending = Promise.resolve();
    this.onLost = onLost;
    this.retryingReward = false;
    this.rewardError = null;
    this.client.on('error', () => {
      this.active = false;
      if (!this.closing) this.onLost?.();
    });
  }

  assertAvailable() {
    if (!this.active || this.rewardError) throw new Error('Database persistence is unavailable');
  }

  get healthy() { return this.active && !this.retryingReward && !this.rewardError; }

  transaction(operation, { retryReward = false } = {}) {
    const result = this.pending.then(async () => {
      let retries = 0;
      try {
        for (;;) {
          this.assertAvailable();
          await this.client.query('BEGIN');
          try {
            const value = await operation(this.client);
            await this.client.query('COMMIT');
            return value;
          } catch (error) {
            await this.client.query('ROLLBACK').catch(() => {});
            if (!retryReward || !RETRYABLE.has(error.code) || !this.active) throw error;
            if (!retries) console.error('[persistence] reward transaction delayed; retrying before later writes');
            this.retryingReward = true;
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, 100 * 2 ** Math.min(retries++, 5))));
          }
        }
      } finally { if (retryReward) this.retryingReward = false; }
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async migrate() {
    const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await this.transaction(async client => {
      await client.query('CREATE TABLE IF NOT EXISTS vb_schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = await client.query('SELECT version, checksum FROM vb_schema_migrations ORDER BY version');
      if (applied.rows.some(row => row.version !== 1 || row.checksum !== checksum)) throw new Error('Unsupported or modified database schema migration');
      if (!applied.rowCount) {
        await client.query(sql);
        await client.query('INSERT INTO vb_schema_migrations(version, checksum) VALUES (1, $1)', [checksum]);
      }
    });
  }

  async close() {
    this.closing = true;
    await this.pending;
    this.active = false;
    await this.client.end();
    if (this.rewardError) throw new Error('A reward could not be persisted');
  }

  async loadAccounts() {
    return this.transaction(async client => {
      const accounts = await client.query('SELECT * FROM vb_accounts ORDER BY created_at_ms, id');
      const sessions = await client.query('SELECT * FROM vb_sessions ORDER BY created_at_ms, hash');
      const byAccount = new Map();
      for (const row of sessions.rows) {
        if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, []);
        byAccount.get(row.account_id).push({ hash: row.hash, createdAt: Number(row.created_at_ms), expiresAt: Number(row.expires_at_ms) });
      }
      return accounts.rows.map(row => ({ version: 1, id: row.id, username: row.username,
        password: row.password, recoveryHash: row.recovery_hash, authVersion: Number(row.auth_version),
        createdAt: Number(row.created_at_ms), updatedAt: Number(row.updated_at_ms), sessions: byAccount.get(row.id) || [],
        ...(row.registration_context === null ? {} : { registrationContext: row.registration_context.value }) }));
    });
  }

  async writeAccount(client, record, creating = false) {
    const values = [record.id, record.username, JSON.stringify(record.password), record.recoveryHash,
      record.authVersion, record.createdAt, record.updatedAt,
      Object.hasOwn(record, 'registrationContext') ? JSON.stringify({ value: record.registrationContext }) : null];
    if (creating) {
      await client.query(`INSERT INTO vb_accounts(id, username, password, recovery_hash, auth_version, created_at_ms, updated_at_ms, registration_context)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, values);
    } else {
      const result = await client.query(`UPDATE vb_accounts SET username=$2, password=$3, recovery_hash=$4,
        auth_version=$5, created_at_ms=$6, updated_at_ms=$7, registration_context=$8 WHERE id=$1`, values);
      if (result.rowCount !== 1) throw new Error('Account disappeared from database');
    }
    await client.query('DELETE FROM vb_sessions WHERE account_id=$1', [record.id]);
    for (const session of record.sessions) await client.query(
      'INSERT INTO vb_sessions(hash, account_id, created_at_ms, expires_at_ms) VALUES ($1,$2,$3,$4)',
      [session.hash, record.id, session.createdAt, session.expiresAt]);
  }

  async saveAccount(record, creating, revokedAccount = null) {
    try { await this.transaction(async client => {
      await this.writeAccount(client, record, creating);
      if (revokedAccount) await this.writeAccount(client, revokedAccount);
    }); }
    catch (error) {
      if (creating && error.code === '23505') throw new AccountError(409, 'That username is already taken');
      throw error;
    }
  }

  async loadClaims() {
    return this.transaction(async client => (await client.query('SELECT guest_id, account_id, profile FROM vb_career_claims')).rows
      .map(row => ({ guest: row.guest_id, account: `account:${row.account_id}`, profile: validateProfile(row.profile) })));
  }

  async writeProfile(client, id, profile) {
    if (!CAREER_ID.test(id || '')) throw new Error('Invalid career identity');
    profile = validateProfile(profile);
    await client.query(`INSERT INTO vb_careers(id, account_id, xp, credits, kills, matches, owned, equipped)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET
      xp=EXCLUDED.xp, credits=EXCLUDED.credits, kills=EXCLUDED.kills, matches=EXCLUDED.matches,
      owned=EXCLUDED.owned, equipped=EXCLUDED.equipped`, [id, id.startsWith('account:') ? id.slice(8) : null,
      profile.xp, profile.credits, profile.kills, profile.matches, JSON.stringify(profile.owned), JSON.stringify(profile.equipped)]);
  }

  async lockedProfile(client, id) {
    if (!CAREER_ID.test(id || '')) throw new Error('Invalid career identity');
    if (!id.startsWith('account:')) {
      const claim = await client.query('SELECT account_id FROM vb_career_claims WHERE guest_id=$1', [id]);
      if (claim.rowCount) return null;
    }
    const rows = await client.query('SELECT * FROM vb_careers WHERE id=$1 FOR UPDATE', [id]);
    if (rows.rowCount) return profileFromRow(rows.rows[0]);
    const profile = emptyProfile();
    await this.writeProfile(client, id, profile);
    return profile;
  }

  readProfile(id) { return this.transaction(client => this.lockedProfile(client, id)); }

  applyProgress(id, delta, { operationId = randomUUID() } = {}) {
    const changes = Object.fromEntries(['xp', 'credits', 'kills', 'matches'].map(key => [key, delta[key] || 0]));
    if (!CAREER_ID.test(id || '') || !Object.values(changes).every(value => Number.isSafeInteger(value) && value >= 0))
      return Promise.reject(new Error('Invalid career reward'));
    return this.transaction(async client => {
      const receipt = await client.query('INSERT INTO vb_reward_receipts(id, profile_id, delta) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id',
        [operationId, id, JSON.stringify(changes)]);
      if (!receipt.rowCount) {
        const previous = (await client.query('SELECT profile_id, delta FROM vb_reward_receipts WHERE id=$1', [operationId])).rows[0];
        if (previous.profile_id !== id || Object.keys(changes).some(key => previous.delta[key] !== changes[key]))
          throw new Error('Reward receipt was reused for a different reward');
        return this.lockedProfile(client, id);
      }
      const profile = await this.lockedProfile(client, id);
      if (!profile) return null;
      for (const key of ['xp', 'credits', 'kills', 'matches']) profile[key] += changes[key];
      await this.writeProfile(client, id, profile);
      return profile;
    }, { retryReward: true }).catch(error => { this.rewardError = error; throw error; });
  }

  purchase(id, itemId, equipOnly, authorized = () => true) {
    return this.transaction(async client => {
      if (!authorized()) throw new Error('Your session changed. Reopen the shop before purchasing.');
      const profile = await this.lockedProfile(client, id), item = CAREER_CATALOG.find(item => item.id === itemId);
      if (!profile || !item) throw new Error('Unknown item');
      if (!profile.owned.includes(item.id)) {
        if (equipOnly) throw new Error('Buy this item first');
        if (careerView(profile).level < item.level) throw new Error(`Requires level ${item.level}`);
        if (profile.credits < item.price) throw new Error('Not enough credits');
        profile.credits -= item.price;
        profile.owned.push(item.id);
      }
      profile.equipped[item.kind] = item.id;
      await this.writeProfile(client, id, profile);
      return careerView(profile);
    });
  }

  claimGuest(guest, account, snapshot) {
    return this.transaction(async client => {
      if (!/^[a-f0-9]{64}$/.test(guest || '') || !/^account:[a-f0-9]{32}$/.test(account || '')) throw new Error('Invalid guest transfer');
      validateProfile(snapshot);
      const existing = await client.query('SELECT guest_id, account_id, profile FROM vb_career_claims WHERE guest_id=$1 OR account_id=$2', [guest, account.slice(8)]);
      if (existing.rowCount) return existing.rows[0].guest_id === guest && existing.rows[0].account_id === account.slice(8)
        ? { guest, account, profile: validateProfile(existing.rows[0].profile) } : null;
      const accountProfile = await client.query('SELECT id FROM vb_careers WHERE id=$1 FOR UPDATE', [account]);
      if (accountProfile.rowCount) throw new Error('Cannot overwrite an existing account career');
      // Include every reward committed before this claim; the registration
      // snapshot is only a recovery source when the legacy guest row is absent.
      const guestProfile = await client.query('SELECT * FROM vb_careers WHERE id=$1 FOR UPDATE', [guest]);
      const profile = guestProfile.rowCount ? profileFromRow(guestProfile.rows[0]) : validateProfile(snapshot);
      await this.writeProfile(client, account, profile);
      await client.query('INSERT INTO vb_career_claims(guest_id, account_id, profile) VALUES ($1,$2,$3)', [guest, account.slice(8), JSON.stringify(profile)]);
      return { guest, account, profile };
    });
  }
}
