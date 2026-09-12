import { randomBytes, randomUUID } from 'node:crypto';
import { AccountError, AccountRateLimits, digest, equalHash, exactObject, validPassword } from './account-security.js';

export const EMAIL_LINK_LIFETIME_MS = 30 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}\.[a-f0-9]{64}$/;
const GENERIC_RESET_MESSAGE = 'If an account has this verified email address, a reset link will arrive shortly. Check your spam folder or try again later.';
const INVALID_LINK = 'This link is invalid or has expired. Request a new one.';

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  const local = email.split('@')[0];
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') ? email : null;
}

export function validateEmailRecovery(value) {
  if (!exactObject(value, ['email', 'pending', 'reset']) || (value.email !== null && normalizeEmail(value.email) !== value.email))
    throw new Error('Invalid recovery email');
  for (const kind of ['pending', 'reset']) {
    const link = value[kind];
    if (link === null) continue;
    if (!exactObject(link, kind === 'pending' ? ['hash', 'expiresAt', 'authVersion', 'email'] : ['hash', 'expiresAt', 'authVersion'])
      || !HASH.test(link.hash) || !Number.isSafeInteger(link.expiresAt) || link.expiresAt < 0
      || !Number.isSafeInteger(link.authVersion) || link.authVersion < 1
      || (kind === 'pending' && (!link.email || normalizeEmail(link.email) !== link.email))
      || (kind === 'reset' && !value.email)) throw new Error('Invalid email link');
  }
}

const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Server-only Resend transport. Provider responses and secrets never enter logs. */
export class ResendMailer {
  constructor({ apiKey = process.env.RESEND_API_KEY, from = process.env.VB_EMAIL_FROM, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetch = fetchImpl;
    this.enabled = Boolean(apiKey && from && !/[\r\n]/.test(from));
    this.active = 0;
  }

  async send({ to, username, url, kind }) {
    if (!this.enabled || this.active >= 2) throw new AccountError(503, 'Email delivery is temporarily unavailable. Try again later.');
    this.active++;
    try {
      const title = kind === 'verify' ? 'Confirm your recovery email' : 'Reset your password';
      const text = `${title} for Voxel Blitz account ${username}.\n\n${url}\n\nThis link expires in 30 minutes and can only be used once. If you did not request it, ignore this email.`;
      const response = await this.fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
          'User-Agent': 'voxel-blitz', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ from: this.from, to: [to], subject: `Voxel Blitz: ${title.toLowerCase()}`, text,
          html: `<h1>${title}</h1><p>For Voxel Blitz account <strong>${escapeHtml(username)}</strong>.</p><p><a href="${escapeHtml(url)}">${title}</a></p><p>This link expires in 30 minutes and can only be used once. If you did not request it, ignore this email.</p>` }),
      });
      if (!response.ok) throw new Error('Email provider rejected request');
      const result = await response.json();
      if (typeof result.id !== 'string' || !result.id) throw new Error('Missing email receipt');
      return result.id;
    } catch {
      throw new AccountError(503, 'Email delivery is temporarily unavailable. Try again later.');
    } finally { this.active--; }
  }
}

/** Durable links belong to account records, so JSON and PostgreSQL share semantics. */
export class AccountEmail {
  constructor(accounts, mailer = new ResendMailer()) {
    this.accounts = accounts;
    this.mailer = mailer;
    this.limits = new AccountRateLimits({ now: accounts.now, usernameLimit: 3, ipLimit: 15 });
    this.deliveries = new Set();
    const origin = accounts.publicOrigin && new URL(accounts.publicOrigin);
    this.enabled = Boolean(mailer?.enabled && origin && (origin.protocol === 'https:'
      || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)));
  }

  view(req, identity = this.accounts.identity(req)) {
    const saved = identity && this.accounts.records.get(identity.id)?.emailRecovery;
    if (!this.enabled && !saved) return {};
    const pending = saved?.pending;
    return { emailRecovery: { enabled: this.enabled, email: saved?.email || null,
      pendingEmail: pending && pending.expiresAt > this.accounts.now()
        && pending.authVersion === this.accounts.records.get(identity.id)?.authVersion ? pending.email : null } };
  }

  available() {
    if (!this.enabled) throw new AccountError(503, 'Email recovery is not configured. Use your recovery code or try again later.');
  }

  throttle(req, email) {
    this.limits.consume('ip', req.socket?.remoteAddress || 'unknown');
    this.limits.consume('email', digest(email));
  }

  link(record, kind) {
    const token = `${record.id}.${randomBytes(32).toString('hex')}`;
    return { token, saved: { hash: digest(`vb-email:${kind}:${token}`),
      expiresAt: this.accounts.now() + EMAIL_LINK_LIFETIME_MS, authVersion: record.authVersion } };
  }

  url(kind, token) {
    // Fragments are not sent in HTTP requests or Referer headers.
    return `${this.accounts.publicOrigin}/#account-${kind}=${token}`;
  }

  async prepareEmail(record, email) {
    const a = this.accounts;
    if ([...a.records.values()].some(other => other.id !== record.id && other.emailRecovery?.email === email))
      throw new AccountError(409, 'This email cannot be added to this account.');
    const { token, saved } = this.link(record, 'verify');
    await a._save({ ...record, updatedAt: a.now(), emailRecovery: { email: record.emailRecovery?.email || null,
      reset: record.emailRecovery?.reset || null, pending: { ...saved, email } } });
    await this.mailer.send({ to: email, username: record.username, url: this.url('verify', token), kind: 'verify' });
  }

  async setEmail(req, _res, data) {
    this.available();
    const email = normalizeEmail(data?.email);
    if (!exactObject(data, ['email', 'currentPassword']) || !email || !validPassword(data.currentPassword))
      throw new AccountError(400, 'Enter a valid email address and your current password.');
    const a = this.accounts, identity = a.sessionIdentity(req);
    if (!identity) throw new AccountError(401, 'Sign in before adding a recovery email.');
    this.throttle(req, email);
    const record = a.records.get(identity.user.id);
    const valid = await a.hasher.verify(data.currentPassword, record.password);
    a._available();
    const current = a.records.get(record.id);
    if (!valid || current.authVersion !== record.authVersion || a.sessionIdentity(req)?.sessionId !== identity.sessionId)
      throw new AccountError(401, 'Current password is incorrect or your session has expired.');
    await this.prepareEmail(current, email);
    return { payload: { user: a.identity(req), ...this.view(req), message: 'Check your inbox and confirm your email address. The link expires in 30 minutes.' } };
  }

  validateLink(token, kind) {
    const a = this.accounts;
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new AccountError(400, INVALID_LINK);
    const record = a.records.get(token.split('.')[0]);
    const link = record?.emailRecovery?.[kind === 'verify' ? 'pending' : 'reset'];
    if (!link || link.expiresAt <= a.now() || link.authVersion !== record.authVersion
      || !equalHash(link.hash, digest(`vb-email:${kind}:${token}`))) throw new AccountError(400, INVALID_LINK);
    return record;
  }

  async verify(req, _res, data) {
    if (!exactObject(data, ['token'])) throw new AccountError(400, INVALID_LINK);
    const a = this.accounts, record = this.validateLink(data.token, 'verify');
    const email = record.emailRecovery.pending.email;
    if ([...a.records.values()].some(other => other.id !== record.id && other.emailRecovery?.email === email))
      throw new AccountError(409, 'This email cannot be added to this account.');
    await a._save({ ...record, updatedAt: a.now(), emailRecovery: { email, pending: null, reset: null } });
    return { payload: { user: a.identity(req), ...this.view(req), message: 'Email confirmed. You can now reset your password by email.' } };
  }

  async forgot(req, _res, data) {
    this.available();
    const email = normalizeEmail(data?.email);
    if (!exactObject(data, ['email']) || !email) throw new AccountError(400, 'Enter a valid email address.');
    this.throttle(req, email);
    const a = this.accounts;
    const record = [...a.records.values()].find(item => item.emailRecovery?.email === email);
    if (record) {
      const { token, saved } = this.link(record, 'reset');
      await a._save({ ...record, updatedAt: a.now(), emailRecovery: { ...record.emailRecovery, reset: saved } });
      // The HTTP result does not wait for the provider only for known addresses.
      // This avoids exposing account existence through provider latency/failures.
      const delivery = Promise.resolve().then(() => this.mailer.send({ to: email, username: record.username,
        url: this.url('reset', token), kind: 'reset' })).catch(() => console.error('[accounts] reset email delivery failed'));
      this.deliveries.add(delivery);
      delivery.finally(() => this.deliveries.delete(delivery));
    }
    return { payload: { message: GENERIC_RESET_MESSAGE } };
  }

  async reset(req, res, data) {
    if (!exactObject(data, ['token', 'newPassword']) || !validPassword(data.newPassword))
      throw new AccountError(400, 'Use a password with 12 to 128 characters.');
    const a = this.accounts, record = this.validateLink(data.token, 'reset');
    a.limits.consume('username', record.username.toLowerCase());
    const password = await a.hasher.hash(data.newPassword);
    a._available();
    const current = this.validateLink(data.token, 'reset');
    await a._save({ ...current, password, updatedAt: a.now(), authVersion: current.authVersion + 1, sessions: [],
      emailRecovery: { ...current.emailRecovery, pending: null, reset: null } });
    a._cookie(req, res);
    return { payload: { user: null, message: 'Password reset. Log in with your new password.' } };
  }
}
