import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CAREER_CATALOG, CAREER_REWARDS, careerView, careerItemState, equipCareerItem, reconcileCareerUnlocks, cosmeticLoadout, normalizeCosmeticLoadout } from '../shared/career.js';
import { CareerClaims, DatabaseCareerClaims, GUEST_TOKEN, careerProfilePath, guestCookie } from './career-identity.js';
import { emptyProfile, validateProfile, normalizeCareerProgress, applyCareerProgress } from './persistence/career-profile.js';

import { WEAPON_IDS } from '../shared/combatmath.js';
import { setProfileAttachments, saveStoredAttachments } from './weapon-loadouts.js';
import { validateAttachments } from '../shared/weapon-attachments.js';

const COOKIE = 'vb-career';

/** Server-owned careers, with account profiles isolated from guest cookies. */
export class CareerService {
  static async create(options = {}) {
    const service = new CareerService(options);
    if (service.store) await service.claims.load();
    return service;
  }

  constructor({ directory = process.env.VB_DATA_DIR || './data', accounts = null, store = null } = {}) {
    this.directory = path.resolve(directory);
    this.accounts = accounts;
    this.store = store;
    this.claims = store ? new DatabaseCareerClaims(store) : new CareerClaims(this.directory);
    this.profiles = new Map();
    this.loadouts = new Map();
    this.decoratedSnapshots = new WeakMap();
    this.dirty = new Set();
    this.sessions = new WeakMap();
    this.pendingRewards = new Set();
    this.rewardError = null;
    this.timer = store ? null : setInterval(() => {
      try { this.flush(); } catch (error) { console.error('[career] save failed:', error.message); }
    }, 1000);
    this.timer?.unref();
  }

  identity(req) {
    const user = this.accounts?.identity(req);
    if (user) return `account:${user.id}`;
    const guest = guestCookie(req);
    return guest && !this.claims.hasGuest(guest) ? guest : null;
  }

  prepareGuest(req) {
    const guest = guestCookie(req);
    if (!guest || this.claims.hasGuest(guest)) return null;
    if (this.store) return this.readProfile(guest).then(profile => profile ? { guest, profile } : null);
    return { guest, profile: JSON.parse(JSON.stringify(this.profile(guest))) };
  }

  adoptGuest(req, user, context = this.prepareGuest(req)) {
    if (!context) return false;
    const { guest, profile } = context, account = `account:${user.id}`;
    if (this.store) return this.store.claimGuest(guest, account, profile).then(claim => {
      if (!claim) return false;
      this.claims.remember(claim);
      this.loadouts.delete(guest);
      this.cacheLoadout(account, claim.profile);
      return true;
    });
    if (!GUEST_TOKEN.test(guest || '') || !careerProfilePath(this.directory, account)
      || !profile || !['xp', 'credits', 'kills', 'matches'].every(key => Number.isSafeInteger(profile[key]) && profile[key] >= 0)
      || !Array.isArray(profile.owned) || !profile.equipped) throw new Error('Invalid guest career transfer');
    // Retried logins use only the original registration snapshot, never the
    // current device's guest profile. The exclusive claim remains single-use.
    if (!this.claims.claim(guest, account, profile)) return false;
    this.profiles.delete(guest);
    this.loadouts.delete(guest);
    this.dirty.delete(guest);
    this.profile(account);
    this.dirty.add(account);
    this.flush([account]);
    return true;
  }

  profile(id) {
    if (this.store) throw new Error('PostgreSQL careers require awaited readProfile');
    const file = careerProfilePath(this.directory, id);
    if (!file || this.claims.hasGuest(id)) return null;
    if (id.startsWith('account:') && this.accounts?.registrationPending?.(id.slice(8)) && !this.claims.forAccount(id))
      throw new Error('Your guest career transfer is pending. Please try again shortly.');
    if (this.profiles.has(id)) {
      const profile = this.profiles.get(id);
      if (reconcileCareerUnlocks(profile).length) this.dirty.add(id);
      this.cacheLoadout(id, profile);
      return profile;
    }
    let profile;
    try {
      profile = validateProfile(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      profile = validateProfile(this.claims.forAccount(id) || emptyProfile());
    }
    this.profiles.set(id, profile);
    this.dirty.add(id);
    this.cacheLoadout(id, profile);
    return profile;
  }

  readProfile(id) {
    if (!this.store) return this.profile(id);
    if (id.startsWith('account:') && this.accounts?.registrationPending?.(id.slice(8)) && !this.claims.forAccount(id))
      throw new Error('Your guest career transfer is pending. Please try again shortly.');
    return this.store.readProfile(id).then(profile => {
      this.cacheLoadout(id, profile);
      return profile;
    }, error => { this.loadouts.delete(id); throw error; });
  }

  cacheLoadout(id, profile) {
    if (id && profile) this.loadouts.set(id, cosmeticLoadout(profile));
    else this.loadouts.delete(id);
  }

  /** Authentication is checked in memory; snapshots never read persistence. */
  clientLoadout(client) {
    if (!client) return normalizeCosmeticLoadout(null);
    try {
      if (client.authRequest) {
        const current = this.identity(client.authRequest);
        client.profileId = current === client.admittedProfileId ? current : null;
      }
      return normalizeCosmeticLoadout(client.profileId ? this.loadouts.get(client.profileId) : null);
    } catch {
      client.profileId = null;
      return normalizeCosmeticLoadout(null);
    }
  }

  /** Preserve a kill's presentation if its owner disconnects before broadcasting. */
  detachClient(client) {
    const loadout = this.clientLoadout(client);
    for (const event of client.room?.engine?.tickEvents || []) {
      if (event.kind === 'kill' && event.killer === client.id) event.cosmetics = loadout;
    }
  }

  decorateSnapshot(snapshot, clients) {
    if (snapshot.t !== 'tick') return snapshot;
    if (this.decoratedSnapshots.has(snapshot)) return this.decoratedSnapshots.get(snapshot);
    const loadouts = new Map((snapshot.players || []).map(player => [player.id, this.clientLoadout(clients.get(player.id))]));
    const decorated = { ...snapshot,
      players: (snapshot.players || []).map(player => ({ ...player, cosmetics: loadouts.get(player.id) })),
      events: (snapshot.events || []).map(event => event.kind !== 'kill' ? event : ({ ...event,
        cosmetics: normalizeCosmeticLoadout(loadouts.get(event.killer) || event.cosmetics || this.clientLoadout(clients.get(event.killer))) })),
    };
    this.decoratedSnapshots.set(snapshot, decorated);
    return decorated;
  }

  flush(ids = this.dirty) {
    if (this.store) return Promise.all([...this.pendingRewards]).then(() => {
      if (this.rewardError) throw this.rewardError;
      return this.store.pending;
    });
    if (!this.dirty.size) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const id of ids) {
      const file = careerProfilePath(this.directory, id);
      if (!file || this.claims.hasGuest(id)) { this.dirty.delete(id); continue; }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file + '.tmp', JSON.stringify(this.profiles.get(id)), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      this.dirty.delete(id);
    }
  }

  dispose() { clearInterval(this.timer); return this.flush(); }

  award(id, reward) {
    return this.applyProgress(id, reward);
  }

  applyProgress(id, delta) {
    const changes = normalizeCareerProgress(delta);
    if (this.store) {
      const saving = this.store.applyProgress(id, changes).then(profile => {
        this.cacheLoadout(id, profile);
        return profile;
      }, error => { this.loadouts.delete(id); throw error; });
      this.pendingRewards.add(saving);
      saving.then(() => this.pendingRewards.delete(saving), error => {
        this.pendingRewards.delete(saving);
        this.rewardError = error;
      });
      return saving;
    }
    const profile = this.profile(id);
    if (!profile) return;
    applyCareerProgress(profile, changes);
    this.dirty.add(id);
    this.cacheLoadout(id, profile);
    return profile;
  }

  /** Called only with authoritative snapshots, once per connection and tick. */
  observe(client, snapshot) {
    if (!client.profileId || snapshot.t !== 'tick' || !client.room) return;
    const match = snapshot.match;
    if (!match || match.mode === 'training') return;
    const self = snapshot.players?.find(p => p.id === client.id);
    if (!self) return;
    let state = this.sessions.get(client);
    if (!state || state.engine !== client.room.engine) {
      state = { engine: client.room.engine, now: -1, active: 0, participated: 0, post: false };
      this.sessions.set(client, state);
    }
    if (snapshot.now <= state.now) return;
    const delta = state.now < 0 ? 0 : Math.min(1000, snapshot.now - state.now);
    state.now = snapshot.now;
    const reward = { xp: 0, credits: 0, kills: 0, matches: 0, pvpKills: 0, wins: 0, mastery: {} };
    const addReward = delta => { reward.xp += delta.xp; reward.credits += delta.credits; };
    for (const event of snapshot.events || []) {
      if (event.kind === 'kill' && event.killer === client.id && event.victim !== client.id) {
        const victim = client.room.engine.entities.get(event.victim) || client.room.engine.combatants?.get(event.victim);
        if (!victim || (self.team && victim.team === self.team)) continue;
        addReward(victim.bot ? CAREER_REWARDS.botKill : CAREER_REWARDS.kill);
        reward.kills++;
        if (!victim.bot) {
          reward.pvpKills++;
          // The accepted kill weapon matters in Gun Game: self.weapon already
          // points at the next weapon after a successful stage transition.
          if (WEAPON_IDS.includes(event.w)) {
            const mastery = reward.mastery[event.w] ||= { kills: 0, headshots: 0 };
            mastery.kills++;
            if (event.hs === true) mastery.headshots++;
          }
        }
      }
      if (['bomb_plant', 'bomb_defuse'].includes(event.kind) && event.id === client.id)
        addReward(CAREER_REWARDS.objective);
    }
    const player = client.room.engine.entities.get(client.id);
    const input = player?.input;
    const active = match.phase === 'live' && self.state === 'alive' && input &&
      (input.keys?.f || input.keys?.b || input.keys?.l || input.keys?.r ||
        input.wantFire || input.keys?.interact || input.reload);
    if (active) {
      state.active += delta;
      state.participated += delta;
      if (state.active >= 60000) {
        state.active -= 60000;
        addReward(CAREER_REWARDS.activeMinute);
      }
    }
    if (match.phase === 'post' && match.winner != null && !state.post) {
      if (state.participated >= 10000) {
        addReward(CAREER_REWARDS.match);
        reward.matches++;
        if (match.winner === self.id || (self.team && match.winner === self.team)) {
          addReward(CAREER_REWARDS.victory);
          reward.wins++;
        }
      }
      state.post = true;
      state.participated = 0;
    } else if (match.phase !== 'post') state.post = false;
    // The 20 Hz observation path is synchronous and makes no database calls
    // until an authoritative event actually earns a nonzero reward.
    if (['xp', 'credits', 'kills', 'matches', 'pvpKills', 'wins'].some(key => reward[key] > 0)) return this.applyProgress(client.profileId, reward);
  }

  purchase(id, itemId, equipOnly = false, authorized = () => true, selection = {}) {
    if (this.store) return this.store.purchase(id, itemId, equipOnly, authorized, selection).then(profile => {
      this.cacheLoadout(id, profile);
      return profile;
    });
    if (!authorized()) throw new Error('Your session changed. Reopen the shop before purchasing.');
    const profile = this.profile(id);
    const item = itemId === 'standard' ? { id: 'standard', kind: selection.slot, weapon: selection.weapon } : CAREER_CATALOG.find(item => item.id === itemId);
    if (!profile || !item) throw new Error('Unknown item');
    const previous = validateProfile(profile);
    const wasDirty = this.dirty.has(id);
    if (item.id !== 'standard' && !profile.owned.includes(item.id)) {
      if (item.unlock === 'earned') throw new Error('Complete all requirements to earn this cosmetic');
      if (equipOnly) throw new Error('Buy this item first');
      if (careerItemState(profile, item).locked) throw new Error(`Requires level ${item.level}`);
      if (profile.credits < item.price) throw new Error('Not enough credits');
      profile.credits -= item.price;
      profile.owned.push(item.id);
    }
    equipCareerItem(profile, item);
    this.dirty.add(id);
    try { this.flush([id]); }
    catch (error) {
      // A failed purchase must leave the balance and inventory unchanged, while
      // preserving play rewards that were already waiting to be saved.
      Object.assign(profile, previous);
      if (wasDirty) this.dirty.add(id);
      else this.dirty.delete(id);
      throw error;
    }
    this.cacheLoadout(id, profile);
    return careerView(profile);
  }

  async saveAttachments(id, weapon, selection, authorized = () => true) {
    validateAttachments(weapon, selection);
    if (this.store) {
      const profile = await saveStoredAttachments(this.store, id, weapon, selection, authorized);
      this.cacheLoadout(id, profile);
      return careerView(profile);
    }
    if (!authorized()) throw new Error('Your session changed. Reopen the armory.');
    const profile = this.profile(id);
    if (!profile) throw new Error('Career unavailable.');
    const previous = profile.equipped, wasDirty = this.dirty.has(id);
    setProfileAttachments(profile, weapon, selection);
    this.dirty.add(id);
    try { this.flush([id]); }
    catch (error) {
      profile.equipped = previous;
      if (!wasDirty) this.dirty.delete(id);
      throw error;
    }
    return careerView(profile);
  }

  async handleHttp(req, res) {
    const route = (req.url || '').split('?')[0];
    if (!['/api/career', '/api/career/purchase', '/api/career/attachments'].includes(route)) return false;
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return true;
    };
    const isRead = route === '/api/career' && req.method === 'GET';
    if (!isRead && (!['/api/career/purchase', '/api/career/attachments'].includes(route) || req.method !== 'POST')) return reply(405, { error: 'Method not allowed' });
    // A custom header plus same-origin requests prevents ambient-cookie purchases.
    if (!isRead && (req.headers['x-vb-career'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site'))
      return reply(403, { error: 'Open the shop from the game' });
    let id;
    try {
      id = this.identity(req);
      if (!id && !isRead) return reply(401, { error: 'Open your career first' });
      if (!id) {
        id = randomBytes(32).toString('hex');
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}`);
      }
      const profile = await this.readProfile(id);
      if (isRead) return reply(200, careerView(profile));
    } catch { return reply(503, { error: 'Your career is temporarily unavailable. Please try again shortly.' }); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return reply(413, { error: 'Request too large' });
      }
      const data = JSON.parse(body);
      if (route === '/api/career/attachments') {
        if (this.identity(req) !== id) return reply(401, { error: 'Your session changed. Reopen the armory.' });
        return reply(200, await this.saveAttachments(id, data?.weapon, data?.attachments, () => this.identity(req) === id));
      }
      if (!data || typeof data.item !== 'string') return reply(400, { error: 'Choose an item' });
      if (this.identity(req) !== id) return reply(401, { error: 'Your session changed. Reopen the shop before purchasing.' });
      return reply(200, await this.purchase(id, data.item, data.equipOnly === true, () => this.identity(req) === id, { slot: data.slot, weapon: data.weapon }));
    } catch (error) { return reply(400, { error: error.message }); }
  }
}
