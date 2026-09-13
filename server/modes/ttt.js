import { randomInt } from 'node:crypto';
import { FunPolicy } from './fun.js';
import { WEAPON_IDS, WEAPONS } from '../../shared/combatmath.js';
import { TTT_WEAPONS, TTT_EQUIPMENT_ACTIONS } from '../../shared/ttt.js';
import { isPowerupSiteSupported } from '../../shared/powerup-sites.js';
import { TttEquipment } from './ttt-equipment.js';
import { raycastVoxels } from '../../shared/raycast.js';

/** Roles never enter public player rows or public events. */
export class TttPolicy extends FunPolicy {
  constructor(context, engine) {
    super(context);
    this.engine = engine;
    this.mode = 'ttt';
    this.phase = 'prep';
    this.phaseEndsAt = null;
    this.round = 1;
    this.roles = new Map();
    this.wallets = new Map();
    this.pickups = new Map();
    this.serial = 0;
    this.equipment = new TttEquipment(this, engine);
  }
  _syncPlayer(p) {
    p.team = null; p.credits = 0; p.bomb = false; p.interaction = null;
    p.owned = []; p.weapon = WEAPON_IDS.indexOf('knife');
    p.mag.fill(0); p.reserve.fill(0); p.grenades.fill(0);
    p.reloading = false; p.reloadState = null;
  }
  onPlayerAdd(player) {
    const result = super.onPlayerAdd(player);
    const p = this._entity(player);
    if (this.phase !== 'prep') { p.state = 'dead'; p.hp = 0; p.respawnAt = Infinity; }
    if (this.phase === 'prep' && this.phaseEndsAt === null) {
      this.phaseEndsAt = this.now + this.rules.prepMs;
      this.seedWeapons();
    }
    return result;
  }
  seedWeapons() {
    this.pickups.clear();
    const sites = [];
    // Sample walkable ground throughout the map, including interiors.
    const { sx, sy, sz } = this.engine.world.dimensions;
    for (let x = 6; x < sx - 6; x += 6) for (let z = 6; z < sz - 6; z += 6) {
      for (let y = 1; y < sy - 2; y++) {
        const site = { x: x + .5, y: y + .02, z: z + .5 };
        if (isPowerupSiteSupported(this.engine.world, site)) { sites.push(site); break; }
      }
    }
    const count = Math.min(sites.length, 48);
    for (let i = 0; i < count; i++) {
      const site = sites.splice(randomInt(sites.length), 1)[0];
      const weapon = TTT_WEAPONS[randomInt(TTT_WEAPONS.length)];
      const def = WEAPONS[weapon];
      this.pickups.set(String(++this.serial), { id: String(this.serial), ...site, weapon,
        mag: def.magSize, reserve: def.spareRounds ?? def.spareMags ?? 0 });
    }
  }
  canRespawn() { return false; }
  canTimedRespawn() { return false; }
  canFire(p) { return this.phase === 'live' && super.canFire(p); }
  canDamage(a, b) { return this.phase === 'live' && super.canDamage(a, b); }
  canUseWeapon(player, weapon) {
    const p = this._entity(player);
    const id = typeof weapon === 'string' ? weapon : WEAPON_IDS[weapon];
    return !!p && p.owned.includes(id);
  }
  playerSnapshot(player) {
    const p = this._entity(player);
    return { ...super.playerSnapshot(player), owned: p?.owned?.slice() ?? [], credits: 0 };
  }
  privateState(id) {
    const role = this.roles.get(String(id)) ?? null;
    return { ...this.equipment.privateState(id), role, credits: this.wallets.get(String(id)) ?? 0,
      allies: role === 'traitor' ? [...this.roles].filter(([,r]) => r === 'traitor').map(([id]) => id) : [] };
  }
  drop(p) {
    if (!p?.owned.length) return false;
    const weapon = p.owned[0], slot = WEAPON_IDS.indexOf(weapon);
    this.pickups.set(String(++this.serial), { id: String(this.serial), x: p.x, y: p.y, z: p.z,
      weapon, mag: p.mag[slot], reserve: p.reserve[slot] });
    this._syncPlayer(p);
    return true;
  }
  buy(player, request) {
    const p = this._entity(player);
    if (!p || !this._players.has(String(p.id)) || p.state !== 'alive' || !['prep','live'].includes(this.phase)) return false;
    if (request === 'ttt:drop') return this.drop(p);
    if (typeof request !== 'string') return false;
    if (request.startsWith('ttt:pickup:')) {
      const item = this.pickups.get(request.slice(11));
      if (!item || p.owned.length || Math.hypot(p.x-item.x, p.y-item.y, p.z-item.z) > 2.4) return false;
      const dx=item.x-p.x, dy=item.y-p.y, dz=item.z-p.z, distance=Math.hypot(dx,dy,dz);
      if (distance > .05 && raycastVoxels(this.engine.solidAt,p.x,p.y+.65,p.z,dx/distance,dy/distance,dz/distance,distance)) return false;
      const slot = WEAPON_IDS.indexOf(item.weapon);
      this.pickups.delete(item.id);
      p.owned = [item.weapon]; p.weapon = slot; p.mag[slot] = item.mag; p.reserve[slot] = item.reserve;
      p.reloading = false; p.reloadState = null;
      return true;
    }
    const item = request.startsWith('ttt:') ? request.slice(4) : '';
    return TTT_EQUIPMENT_ACTIONS.includes(item)
      ? this.equipment.action(p, item) : this.equipment.buy(p, item);
  }

  onPlayerDeath(victim) {
    const p = this._entity(victim);
    if (!p) return false;
    this.equipment.remove(p.id);
    this.drop(p); p.respawnAt = Infinity;
    return true;
  }
  onPlayerRemove(player) {
    const p = this._entity(player);
    if (p) { this.drop(p); this.equipment.remove(p.id); }
    return super.onPlayerRemove(player);
  }
  onPlayerTakeover(player, nextId) {
    const p = this._entity(player), old = String(p?.id);
    if (!super.onPlayerTakeover(player, nextId)) return false;
    this.equipment.takeover(old, nextId);
    if (this.roles.has(old)) { this.roles.set(String(nextId),this.roles.get(old)); this.roles.delete(old); }
    if (this.wallets.has(old)) { this.wallets.set(String(nextId),this.wallets.get(old)); this.wallets.delete(old); }
    return true;
  }
  tick() {
    for (const item of this.pickups.values()) {
      const floor = Math.floor(item.y);
      if (this.engine.solidAt(Math.floor(item.x), floor - 1, Math.floor(item.z))) item.y = floor + .02;
      else item.y = Math.max(1.02, item.y - .5);
    }
    if (this.phase === 'post') {
      this.phase = 'prep'; this.phaseEndsAt = this.now + this.rules.prepMs;
      this.matchWinner = null; this.roles.clear(); this.wallets.clear(); this.equipment.clear(); this.round++;
      for (const p of this._entities.values()) { p.kills=p.deaths=p.score=0; this._respawn(p); }
      this.seedWeapons();
      return;
    }
    if (this.phase === 'prep' && this.phaseEndsAt !== null && this.now >= this.phaseEndsAt) {
      const players = [...this._entities.values()].filter(p => p.state === 'alive');
      if (players.length < 2) return;
      for (let i=players.length-1;i>0;i--) { const j=randomInt(i+1); [players[i],players[j]]=[players[j],players[i]]; }
      players.forEach((p,i) => { const role=i<Math.max(1,Math.floor(players.length/4))?'traitor':'innocent';
        this.roles.set(String(p.id),role); this.wallets.set(String(p.id),role==='traitor'?2:0); });
      this.phase = 'live'; this.phaseEndsAt = this.now + this.rules.liveMs;
    }
    if (this.phase !== 'live') return;
    this.equipment.tick();
    const living=[...this._entities.values()].filter(p=>p.state==='alive' && this.roles.has(String(p.id)));
    const traitors=living.filter(p=>this.roles.get(String(p.id))==='traitor').length;
    if (!traitors || traitors===living.length || this.now>=this.phaseEndsAt) {
      this.matchWinner = !traitors || this.now>=this.phaseEndsAt ? 'innocent' : 'traitor';
      this.phase='post'; this.phaseEndsAt=null;
    }
  }
  matchSnapshot() {
    return { ...super.matchSnapshot(), phaseEndsAt: this.phaseEndsAt, round: this.round, winner: this.matchWinner,
      weaponPickups: [...this.pickups.values()].map(({mag,reserve,...item})=>item),
      ...(this.phase==='post'?{ revealedRoles: Object.fromEntries(this.roles) }: {}) };
  }
  botGoal(player) {
    const p=this._entity(player);
    if (p?.state!=='alive') return {kind:'spectate',target:null,interact:false};
    if (!p.owned.length) {
      const item=[...this.pickups.values()].sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
      if (item) { this.buy(p,`ttt:pickup:${item.id}`); return {kind:'move',target:item,interact:false}; }
    }
    return {kind:this.phase==='prep'?'move':'fight',target:null,interact:false};
  }
}
