import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP scrypt baseline; Node requires maxmem above 128 * N * r.
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
// https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback
export const PASSWORD_COST = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
export const ACCOUNT_COOKIE = 'vb-account';
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const HEX_64 = /^[a-f0-9]{64}$/;
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

export class AccountError extends Error {
  constructor(status, message, { retryAfter = null, close = false } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.close = close;
  }
}

export function validUsername(value) {
  return typeof value === 'string' && USERNAME.test(value);
}

export function validPassword(value) {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= 12 && length <= 128 && Buffer.from(value).toString('utf8') === value;
}

export function exactObject(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sessionHash(req) {
  const cookies = String(req.headers?.cookie || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(ACCOUNT_COOKIE + '='));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(ACCOUNT_COOKIE.length + 1);
  return HEX_64.test(token) ? digest(`vb-session:v1:${token}`) : null;
}

export function freshSession() {
  const token = randomBytes(32).toString('hex');
  return { token, hash: digest(`vb-session:v1:${token}`) };
}

export function freshRecoveryCode() {
  return randomBytes(24).toString('hex').toUpperCase().match(/.{8}/g).join('-');
}

export function recoveryHash(userId, value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const code = value.replace(/[-\s]/g, '').toLowerCase();
  return /^[a-f0-9]{48}$/.test(code) ? digest(`vb-recovery:v1:${userId}:${code}`) : null;
}

export function equalHash(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && HEX_64.test(left) && HEX_64.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Bound both CPU/RAM work and queued requests carrying passwords. */
export class PasswordHasher {
  constructor({ concurrency = 2, queueLimit = 8 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
      || !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 32) throw new TypeError('Invalid hash limits');
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.active = 0;
    this.queue = [];
    this.closed = false;
  }

  async run(password, salt) {
    if (this.closed) throw new AccountError(503, 'Accounts are temporarily unavailable');
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.queue.length >= this.queueLimit) throw new AccountError(503, 'Accounts are busy. Try again shortly', { retryAfter: 3 });
      await new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
    }
    try {
      if (this.closed) throw new AccountError(503, 'Accounts are temporarily unavailable');
      return await new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64, PASSWORD_COST,
        (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
    } finally {
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.active--;
    }
  }

  async hash(password) {
    const salt = randomBytes(16).toString('hex');
    return { algorithm: 'scrypt', N: PASSWORD_COST.N, r: PASSWORD_COST.r, p: PASSWORD_COST.p,
      salt, hash: await this.run(password, salt) };
  }

  async verify(password, saved = null) {
    // Unknown usernames pay the same KDF cost as a wrong existing password.
    const salt = saved?.salt || '00000000000000000000000000000000';
    const hash = await this.run(password, salt);
    const expected = saved?.hash || '0'.repeat(128);
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex')) && !!saved;
  }

  dispose() {
    this.closed = true;
    for (const pending of this.queue.splice(0)) pending.reject(new AccountError(503, 'Accounts are temporarily unavailable'));
  }
}

/** Fixed windows have bounded storage and never evict a live limit to admit a new key. */
export class AccountRateLimits {
  constructor({ now = Date.now, windowMs = 10 * 60 * 1000, ipLimit = 60, usernameLimit = 12, maxEntries = 4096 } = {}) {
    if (![windowMs, ipLimit, usernameLimit, maxEntries].every(value => Number.isSafeInteger(value) && value > 0))
      throw new TypeError('Invalid account rate limits');
    this.now = now;
    this.windowMs = windowMs;
    this.ipLimit = ipLimit;
    this.usernameLimit = usernameLimit;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  consume(kind, key) {
    const now = this.now(), id = `${kind}:${key}`;
    let entry = this.entries.get(id);
    if (entry && entry.until <= now) { this.entries.delete(id); entry = null; }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        for (const [name, candidate] of this.entries) if (candidate.until <= now) this.entries.delete(name);
        if (this.entries.size >= this.maxEntries) throw new AccountError(429, 'Too many attempts. Try again later', { retryAfter: 60 });
      }
      entry = { count: 0, until: now + this.windowMs };
      this.entries.set(id, entry);
    }
    const limit = kind === 'ip' ? this.ipLimit : this.usernameLimit;
    if (entry.count >= limit) throw new AccountError(429, 'Too many attempts. Try again later',
      { retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)) });
    entry.count++;
  }
}

export function secureRequest(req) {
  return !!req.socket?.encrypted || req.headers?.['x-forwarded-proto'] === 'https';
}

export function sameOriginWrite(req, publicOrigin = null) {
  if (req.headers?.['x-vb-account'] !== '1') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  try {
    const origin = new URL(req.headers.origin);
    const expected = publicOrigin || `${secureRequest(req) ? 'https' : 'http'}://${req.headers.host}`;
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === expected
      && origin.href === `${origin.origin}/`;
  } catch { return false; }
}

export function readAccountJson(req, { maxBytes = 4096, timeoutMs = 5000 } = {}) {
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new AccountError(415, 'Send account requests as JSON', { close: true });
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes))
    throw new AccountError(413, 'Request too large', { close: true });
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort);
      if (error) { req.pause(); reject(error); }
      else resolve(value);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) return finish(new AccountError(413, 'Request too large', { close: true }));
      chunks.push(bytes);
    };
    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (Buffer.byteLength(text) !== size) throw new Error('Invalid UTF-8');
        finish(null, JSON.parse(text));
      } catch { finish(new AccountError(400, 'Invalid account request')); }
    };
    const onError = () => finish(new AccountError(400, 'Incomplete account request', { close: true }));
    const onAbort = () => finish(new AccountError(400, 'Incomplete account request', { close: true }));
    const timer = setTimeout(() => finish(new AccountError(408, 'Account request timed out', { close: true })), timeoutMs);
    timer.unref?.();
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAbort);
    if (req.aborted || req.destroyed) onAbort();
  });
}
