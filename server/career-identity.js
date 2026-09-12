import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const GUEST_TOKEN = /^[a-f0-9]{64}$/;
const ACCOUNT_KEY = /^account:([a-f0-9]{32})$/;
const copy = value => JSON.parse(JSON.stringify(value));

export function careerProfilePath(directory, id) {
  if (GUEST_TOKEN.test(id || '')) return path.join(directory, id + '.json');
  const account = ACCOUNT_KEY.exec(id || '');
  return account ? path.join(directory, 'account-careers', account[1] + '.json') : null;
}

export function guestCookie(req) {
  const value = String(req.headers?.cookie || '').split(';').map(v => v.trim())
    .find(v => v.startsWith('vb-career='))?.slice('vb-career='.length);
  return GUEST_TOKEN.test(value || '') ? value : null;
}

/** A durable claim is the transfer boundary. Its snapshot also recovers an
 * interrupted first account-profile save without importing a guest twice. */
export class CareerClaims {
  constructor(directory) {
    this.directory = path.join(directory, 'career-claims');
    this.loaded = false;
    this.guests = new Map();
    this.accounts = new Map();
  }

  load() {
    if (this.loaded) return;
    const guests = new Map(), accounts = new Map();
    if (existsSync(this.directory)) {
      for (const name of readdirSync(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const claim = JSON.parse(readFileSync(path.join(this.directory, name), 'utf8'));
        if (!ACCOUNT_KEY.test(claim.account || '') || !claim.profile || accounts.has(claim.account))
          throw new Error('Invalid career transfer record');
        const guest = name.slice(0, -5);
        guests.set(guest, claim);
        accounts.set(claim.account, claim);
      }
    }
    this.guests = guests;
    this.accounts = accounts;
    this.loaded = true;
  }

  hasGuest(id) { this.load(); return this.guests.has(id); }
  forAccount(id) { this.load(); return copy(this.accounts.get(id)?.profile ?? null); }

  claim(guest, account, profile) {
    this.load();
    if (!GUEST_TOKEN.test(guest || '') || !ACCOUNT_KEY.test(account || '')) return false;
    if (this.guests.has(guest)) return this.guests.get(guest).account === account;
    if (this.accounts.has(account)) return false;
    const record = { account, profile: copy(profile) };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Publish a complete record with an exclusive atomic link. An interrupted
    // temporary write cannot become a partial claim or overwrite another one.
    const temporary = path.join(this.directory, randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      linkSync(temporary, path.join(this.directory, guest + '.json'));
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.guests.set(guest, record);
    this.accounts.set(account, record);
    return true;
  }
}
