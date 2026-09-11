import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CAREER_CATALOG, CAREER_REWARDS, careerView } from '../shared/career.js';

const COOKIE = 'vb-career';
const TOKEN = /^[a-f0-9]{64}$/;
const emptyProfile = () => ({ xp: 0, credits: 0, kills: 0, matches: 0,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' } });

/** One server-owned profile per browser cookie. No client-supplied XP or prices. */
export class CareerService {
  constructor({ directory = process.env.VB_DATA_DIR || './data' } = {}) {
    this.directory = path.resolve(directory);
    this.profiles = new Map();
    this.dirty = new Set();
    this.sessions = new WeakMap();
    this.timer = setInterval(() => {
      try { this.flush(); } catch (error) { console.error('[career] save failed:', error.message); }
    }, 1000);
    this.timer.unref();
  }

  identity(req) {
    const value = String(req.headers?.cookie || '').split(';').map(v => v.trim())
      .find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return TOKEN.test(value || '') ? value : null;
  }

  profile(id) {
    if (!TOKEN.test(id || '')) return null;
    if (this.profiles.has(id)) return this.profiles.get(id);
    let profile;
    try {
      profile = JSON.parse(readFileSync(path.join(this.directory, id + '.json'), 'utf8'));
      if (!['xp', 'credits', 'kills', 'matches'].every(k => Number.isSafeInteger(profile[k]) && profile[k] >= 0)
          || !Array.isArray(profile.owned) || !profile.equipped) throw new Error('Invalid career data');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      profile = emptyProfile();
    }
    this.profiles.set(id, profile);
    return profile;
  }

  flush(ids = this.dirty) {
    if (!this.dirty.size) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const id of ids) {
      const file = path.join(this.directory, id + '.json');
      writeFileSync(file + '.tmp', JSON.stringify(this.profiles.get(id)), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      this.dirty.delete(id);
    }
  }

  dispose() { clearInterval(this.timer); this.flush(); }

  award(id, reward) {
    const profile = this.profile(id);
    if (!profile) return;
    profile.xp += reward.xp;
    profile.credits += reward.credits;
    this.dirty.add(id);
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
    const profile = this.profile(client.profileId);
    for (const event of snapshot.events || []) {
      if (event.kind === 'kill' && event.killer === client.id && event.victim !== client.id) {
        const victim = client.room.engine.entities.get(event.victim) || client.room.engine.combatants?.get(event.victim);
        if (!victim || (self.team && victim.team === self.team)) continue;
        this.award(client.profileId, victim.bot ? CAREER_REWARDS.botKill : CAREER_REWARDS.kill);
        profile.kills++;
      }
      if (['bomb_plant', 'bomb_defuse'].includes(event.kind) && event.id === client.id)
        this.award(client.profileId, CAREER_REWARDS.objective);
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
        this.award(client.profileId, CAREER_REWARDS.activeMinute);
      }
    }
    if (match.phase === 'post' && match.winner != null && !state.post) {
      if (state.participated >= 10000) {
        this.award(client.profileId, CAREER_REWARDS.match);
        profile.matches++;
        if (match.winner === self.id || (self.team && match.winner === self.team))
          this.award(client.profileId, CAREER_REWARDS.victory);
      }
      state.post = true;
      state.participated = 0;
    } else if (match.phase !== 'post') state.post = false;
  }

  purchase(id, itemId, equipOnly = false) {
    const profile = this.profile(id), item = CAREER_CATALOG.find(item => item.id === itemId);
    if (!profile || !item) throw new Error('Unknown item');
    const previous = { ...profile, owned: [...profile.owned], equipped: { ...profile.equipped } };
    const wasDirty = this.dirty.has(id);
    if (!profile.owned.includes(item.id)) {
      if (equipOnly) throw new Error('Buy this item first');
      if (careerView(profile).level < item.level) throw new Error(`Requires level ${item.level}`);
      if (profile.credits < item.price) throw new Error('Not enough credits');
      profile.credits -= item.price;
      profile.owned.push(item.id);
    }
    profile.equipped[item.kind] = item.id;
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
    return careerView(profile);
  }

  async handleHttp(req, res) {
    const route = (req.url || '').split('?')[0];
    if (!['/api/career', '/api/career/purchase'].includes(route)) return false;
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return true;
    };
    const isRead = route === '/api/career' && req.method === 'GET';
    if (!isRead && (route !== '/api/career/purchase' || req.method !== 'POST')) return reply(405, { error: 'Method not allowed' });
    // A custom header plus same-origin requests prevents ambient-cookie purchases.
    if (!isRead && (req.headers['x-vb-career'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site'))
      return reply(403, { error: 'Open the shop from the game' });
    let id = this.identity(req);
    if (!id && !isRead) return reply(401, { error: 'Open your career first' });
    if (!id) {
      id = randomBytes(32).toString('hex');
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}`);
    }
    if (isRead) return reply(200, careerView(this.profile(id)));
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return reply(413, { error: 'Request too large' });
      }
      const data = JSON.parse(body);
      if (!data || typeof data.item !== 'string') return reply(400, { error: 'Choose an item' });
      return reply(200, this.purchase(id, data.item, data.equipOnly === true));
    } catch (error) { return reply(400, { error: error.message }); }
  }
}
