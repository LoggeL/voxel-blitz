import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ACCOUNT_COOKIE, SESSION_LIFETIME_MS, PASSWORD_COST, AccountError, AccountRateLimits,
  PasswordHasher, equalHash, exactObject, freshRecoveryCode, freshSession, readAccountJson,
  recoveryHash, sameOriginWrite, secureRequest, sessionHash, validPassword, validUsername } from './account-security.js';

const USER_ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 10;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_REGISTRATION_CONTEXT_BYTES = 16 * 1024;
const TRANSFER_WARNING = 'Your account is ready. Your previous progress is still being transferred. Refresh or sign in again to retry.';
const publicUser = record => ({ id: record.id, username: record.username });
const safeTime = value => Number.isSafeInteger(value) && value >= 0;

function validateRecord(record, filename) {
  const password = record?.password;
  const keys = ['version', 'id', 'username', 'password', 'recoveryHash', 'authVersion', 'createdAt', 'updatedAt', 'sessions'];
  if (record && Object.hasOwn(record, 'registrationContext')) {
    keys.push('registrationContext');
    if (Buffer.byteLength(JSON.stringify(record.registrationContext)) > MAX_REGISTRATION_CONTEXT_BYTES) throw new Error('Invalid registration context');
  }
  if (!exactObject(record, keys)
    || record.version !== 1 || !USER_ID.test(record.id) || !validUsername(record.username)
    || filename !== `${record.username.toLowerCase()}.json`
    || !HASH.test(record.recoveryHash) || !Number.isSafeInteger(record.authVersion) || record.authVersion < 1
    || !safeTime(record.createdAt) || !safeTime(record.updatedAt) || record.updatedAt < record.createdAt
    || !exactObject(password, ['algorithm', 'N', 'r', 'p', 'salt', 'hash'])
    || password.algorithm !== 'scrypt' || password.N !== PASSWORD_COST.N || password.r !== PASSWORD_COST.r || password.p !== PASSWORD_COST.p
    || !/^[a-f0-9]{32}$/.test(password.salt) || !/^[a-f0-9]{128}$/.test(password.hash)
    || !Array.isArray(record.sessions) || record.sessions.length > MAX_SESSIONS) throw new Error('Invalid account record');
  const hashes = new Set();
  for (const session of record.sessions) {
    if (!exactObject(session, ['hash', 'createdAt', 'expiresAt']) || !HASH.test(session.hash)
      || hashes.has(session.hash) || !safeTime(session.createdAt) || !safeTime(session.expiresAt)
      || session.expiresAt <= session.createdAt || session.expiresAt - session.createdAt > SESSION_LIFETIME_MS)
      throw new Error('Invalid account session');
    hashes.add(session.hash);
  }
  return record;
}

/** Optional local accounts; hashed credentials and sessions stay outside static roots. */
export class AccountService {
  constructor({ directory = path.join(process.env.VB_DATA_DIR || './data', 'accounts'), now = Date.now,
    sessionLifetimeMs = SESSION_LIFETIME_MS, rateLimits = {}, hashLimits = {}, bodyTimeoutMs = 5000,
    onRegistering = null, onRegistered = null, publicOrigin = process.env.VB_PUBLIC_ORIGIN || null, maxAccounts = 10000 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1000
      || sessionLifetimeMs > SESSION_LIFETIME_MS || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1
      || !Number.isSafeInteger(maxAccounts) || maxAccounts < 1) throw new TypeError('Invalid account settings');
    if (onRegistered != null && typeof onRegistered !== 'function') throw new TypeError('Invalid registration callback');
    if (onRegistering != null && typeof onRegistering !== 'function') throw new TypeError('Invalid registration preparation');
    if (publicOrigin && (!['http:', 'https:'].includes(new URL(publicOrigin).protocol)
      || new URL(publicOrigin).origin !== publicOrigin)) throw new TypeError('Invalid public origin');
    this.directory = path.resolve(directory);
    this.now = now;
    this.sessionLifetimeMs = sessionLifetimeMs;
    this.bodyTimeoutMs = bodyTimeoutMs;
    this.onRegistered = onRegistered;
    this.onRegistering = onRegistering;
    this.registrationJobs = new Map();
    this.publicOrigin = publicOrigin;
    this.maxAccounts = maxAccounts;
    this.records = new Map();
    this.usernames = new Map();
    this.sessions = new Map();
    this.hasher = new PasswordHasher(hashLimits);
    this.limits = new AccountRateLimits({ ...rateLimits, now });
    this.closed = false;
    this.unavailable = false;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      for (const filename of readdirSync(this.directory)) {
        if (!filename.endsWith('.json')) continue;
        if (!/^[a-z0-9_-]{3,20}\.json$/.test(filename) || this.records.size >= maxAccounts) throw new Error('Invalid account store');
        const file = path.join(this.directory, filename);
        if (!statSync(file).isFile() || statSync(file).size > MAX_RECORD_BYTES) throw new Error('Invalid account file');
        const record = validateRecord(JSON.parse(readFileSync(file, 'utf8')), filename);
        if (this.records.has(record.id) || this.usernames.has(record.username.toLowerCase())) throw new Error('Duplicate account');
        for (const session of record.sessions) if (this.sessions.has(session.hash)) throw new Error('Duplicate session');
        this._remember(record);
      }
    } catch {
      this.unavailable = true;
      this.records.clear(); this.usernames.clear(); this.sessions.clear();
      console.error('[accounts] account storage is unavailable');
    }
  }

  sessionIdentity(req) {
    if (this.closed || this.unavailable) return null;
    const hash = sessionHash(req);
    const session = hash && this.sessions.get(hash);
    if (!session || session.expiresAt <= this.now()) return null;
    const record = this.records.get(session.userId);
    return record ? { user: publicUser(record), sessionId: hash } : null;
  }

  identity(req) { return this.sessionIdentity(req)?.user || null; }

  registrationPending(userId) {
    const record = this.records.get(userId);
    return !!record && Object.hasOwn(record, 'registrationContext');
  }

  async _finishRegistration(req, userId) {
    if (!this.registrationPending(userId)) return true;
    if (!this.onRegistered) return false;
    if (this.registrationJobs.has(userId)) return this.registrationJobs.get(userId);
    const job = (async () => {
      try {
        const record = this.records.get(userId);
        // The callback receives the original durable snapshot, never a later
        // login's guest cookie. Its own claim publication is idempotent.
        await this.onRegistered(req, publicUser(record), structuredClone(record.registrationContext));
        const current = { ...this.records.get(userId) };
        delete current.registrationContext;
        this._save(current);
        return true;
      } catch {
        console.error('[accounts] registration follow-up will be retried');
        return false;
      }
    })();
    this.registrationJobs.set(userId, job);
    try { return await job; }
    finally { this.registrationJobs.delete(userId); }
  }

  dispose() { this.closed = true; this.hasher.dispose(); }

  _available() {
    if (this.closed || this.unavailable) throw new AccountError(503, 'Accounts are temporarily unavailable');
  }

  _remember(record) {
    for (const session of this.records.get(record.id)?.sessions || []) this.sessions.delete(session.hash);
    this.records.set(record.id, record);
    this.usernames.set(record.username.toLowerCase(), record.id);
    for (const session of record.sessions) this.sessions.set(session.hash, { userId: record.id, expiresAt: session.expiresAt });
  }

  _save(record, creating = false) {
    this._available();
    const filename = `${record.username.toLowerCase()}.json`;
    validateRecord(record, filename);
    const file = path.join(this.directory, filename);
    const temporary = path.join(this.directory, `.${record.id}.${randomBytes(8).toString('hex')}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor); closeSync(descriptor); descriptor = null;
      // link creates atomically without overwriting a concurrent registration.
      if (creating) { linkSync(temporary, file); unlinkSync(temporary); }
      else renameSync(temporary, file);
      let directoryFd;
      try { directoryFd = openSync(this.directory, 'r'); fsyncSync(directoryFd); }
      finally { if (directoryFd !== undefined) closeSync(directoryFd); }
    } catch (error) {
      if (descriptor != null) try { closeSync(descriptor); } catch {}
      try { unlinkSync(temporary); } catch {}
      if (creating && error.code === 'EEXIST') throw new AccountError(409, 'That username is already taken');
      throw error;
    }
    this._remember(record);
  }

  _withSession(record, session, revoke = false) {
    const now = this.now();
    const previous = revoke ? [] : record.sessions.filter(item => item.expiresAt > now && item.hash !== session.hash);
    return { ...record, updatedAt: now,
      sessions: [...previous.slice(-(MAX_SESSIONS - 1)), { hash: session.hash, createdAt: now, expiresAt: now + this.sessionLifetimeMs }] };
  }

  _cookie(req, res, token = null) {
    const maxAge = token ? Math.floor(this.sessionLifetimeMs / 1000) : 0;
    const value = `${ACCOUNT_COOKIE}=${token || ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureRequest(req) ? '; Secure' : ''}`;
    const existing = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value);
  }

  _revokePresentedSession(req) {
    const identity = this.sessionIdentity(req);
    if (!identity) return;
    const record = this.records.get(identity.user.id);
    this._save({ ...record, updatedAt: this.now(), sessions: record.sessions.filter(session => session.hash !== identity.sessionId) });
  }

  _credentials(data, keys = ['username', 'password']) {
    if (!exactObject(data, keys)) throw new AccountError(400, 'Invalid account request');
    if (!validUsername(data.username)) throw new AccountError(400, 'Use 3 to 20 letters, numbers, underscores or hyphens for your username');
    if (!validPassword(data.password)) throw new AccountError(400, 'Use a password with 12 to 128 characters');
  }

  async _register(req, res, data) {
    this._credentials(data);
    const normalized = data.username.toLowerCase();
    this.limits.consume('username', normalized);
    if (this.usernames.has(normalized)) throw new AccountError(409, 'That username is already taken');
    if (this.records.size >= this.maxAccounts) throw new AccountError(503, 'New accounts are temporarily unavailable');
    const password = await this.hasher.hash(data.password);
    this._available();
    if (this.usernames.has(normalized)) throw new AccountError(409, 'That username is already taken');
    if (this.records.size >= this.maxAccounts) throw new AccountError(503, 'New accounts are temporarily unavailable');
    const code = freshRecoveryCode(), session = freshSession(), now = this.now();
    const id = randomBytes(16).toString('hex');
    const record = this._withSession({ version: 1, id, username: data.username, password,
      recoveryHash: recoveryHash(id, code), authVersion: 1, createdAt: now, updatedAt: now, sessions: [] }, session);
    if (this.onRegistered) {
      const context = await this.onRegistering?.(req) ?? null;
      const serialized = JSON.stringify(context);
      if (Buffer.byteLength(serialized) > MAX_REGISTRATION_CONTEXT_BYTES) throw new AccountError(503, 'Accounts are temporarily unavailable');
      record.registrationContext = JSON.parse(serialized);
    }
    this._save(record, true);
    this._revokePresentedSession(req);
    const user = publicUser(record);
    const transferred = await this._finishRegistration(req, id);
    this._cookie(req, res, session.token);
    return { status: 201, payload: { user, recoveryCode: code, ...(!transferred ? { warning: TRANSFER_WARNING } : {}) } };
  }

  async _login(req, res, data) {
    this._credentials(data);
    const normalized = data.username.toLowerCase();
    this.limits.consume('username', normalized);
    const record = this.records.get(this.usernames.get(normalized));
    const valid = await this.hasher.verify(data.password, record?.password);
    this._available();
    const current = record && this.records.get(record.id);
    if (!valid || !current || current.authVersion !== record.authVersion)
      throw new AccountError(401, 'Username or password is incorrect');
    const session = freshSession();
    this._save(this._withSession(current, session));
    this._revokePresentedSession(req);
    const transferred = await this._finishRegistration(req, current.id);
    this._cookie(req, res, session.token);
    return { payload: { user: publicUser(current), ...(!transferred ? { warning: TRANSFER_WARNING } : {}) } };
  }

  _logout(req, res, data) {
    if (!exactObject(data, [])) throw new AccountError(400, 'Invalid account request');
    const identity = this.sessionIdentity(req);
    if (identity) {
      const record = this.records.get(identity.user.id);
      this._save({ ...record, updatedAt: this.now(), sessions: record.sessions.filter(session => session.hash !== identity.sessionId) });
    }
    this._cookie(req, res);
    return { payload: { user: null } };
  }

  async _password(req, res, data) {
    if (!exactObject(data, ['currentPassword', 'newPassword']) || !validPassword(data.currentPassword) || !validPassword(data.newPassword))
      throw new AccountError(400, 'Use passwords with 12 to 128 characters');
    const identity = this.sessionIdentity(req);
    if (!identity) throw new AccountError(401, 'Sign in before changing your password');
    const record = this.records.get(identity.user.id);
    this.limits.consume('username', record.username.toLowerCase());
    const valid = await this.hasher.verify(data.currentPassword, record.password);
    if (!valid) throw new AccountError(401, 'Current password is incorrect');
    const password = await this.hasher.hash(data.newPassword);
    this._available();
    const current = this.records.get(record.id);
    if (current.authVersion !== record.authVersion || this.sessionIdentity(req)?.sessionId !== identity.sessionId)
      throw new AccountError(401, 'Sign in again before changing your password');
    const session = freshSession();
    this._save(this._withSession({ ...current, password, authVersion: current.authVersion + 1 }, session, true));
    this._cookie(req, res, session.token);
    return { payload: { user: publicUser(current) } };
  }

  async _recover(req, res, data) {
    if (!exactObject(data, ['username', 'recoveryCode', 'newPassword']) || !validUsername(data.username)
      || typeof data.recoveryCode !== 'string' || data.recoveryCode.length > 100 || !validPassword(data.newPassword))
      throw new AccountError(400, 'Enter your username, recovery code and a password with 12 to 128 characters');
    const normalized = data.username.toLowerCase();
    this.limits.consume('username', normalized);
    const record = this.records.get(this.usernames.get(normalized));
    const supplied = recoveryHash(record?.id || '0'.repeat(32), data.recoveryCode);
    if (!equalHash(supplied, record?.recoveryHash || '0'.repeat(64))) throw new AccountError(401, 'Recovery details are incorrect');
    const password = await this.hasher.hash(data.newPassword);
    this._available();
    const current = this.records.get(record.id);
    if (current.authVersion !== record.authVersion || current.recoveryHash !== record.recoveryHash)
      throw new AccountError(401, 'Recovery details are incorrect');
    const code = freshRecoveryCode(), session = freshSession();
    this._save(this._withSession({ ...current, password, recoveryHash: recoveryHash(current.id, code),
      authVersion: current.authVersion + 1 }, session, true));
    this._cookie(req, res, session.token);
    return { payload: { user: publicUser(current), recoveryCode: code } };
  }

  async handleHttp(req, res) {
    const route = (req.url || '').split('?')[0];
    if (route !== '/api/account' && !route.startsWith('/api/account/')) return false;
    const reply = (status, payload, error = null) => {
      if (res.destroyed || res.writableEnded) return true;
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (error?.retryAfter) headers['Retry-After'] = String(error.retryAfter);
      if (error?.close) headers.Connection = 'close';
      res.writeHead(status, headers); res.end(JSON.stringify(payload));
      return true;
    };
    try {
      this._available();
      if (route === '/api/account') {
        if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
        const user = this.identity(req);
        const transferred = !user || await this._finishRegistration(req, user.id);
        return reply(200, { user: this.identity(req), ...(!transferred ? { warning: TRANSFER_WARNING } : {}) });
      }
      const action = { '/api/account/register': '_register', '/api/account/login': '_login',
        '/api/account/logout': '_logout', '/api/account/password': '_password', '/api/account/recover': '_recover' }[route];
      if (!action) return reply(404, { error: 'Account endpoint not found' });
      if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
      if (!sameOriginWrite(req, this.publicOrigin)) throw new AccountError(403, 'Open account settings from the game', { close: true });
      // Never trust a client-supplied forwarding address for throttling.
      this.limits.consume('ip', req.socket?.remoteAddress || 'unknown');
      const data = await readAccountJson(req, { timeoutMs: this.bodyTimeoutMs });
      this._available();
      const result = await this[action](req, res, data);
      return reply(result.status || 200, result.payload);
    } catch (error) {
      if (error instanceof AccountError) return reply(error.status, { error: error.message }, error);
      console.error('[accounts] account operation failed');
      return reply(503, { error: 'Accounts are temporarily unavailable' });
    }
  }
}
