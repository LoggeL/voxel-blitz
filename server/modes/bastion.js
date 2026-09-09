import { randomUUID } from 'node:crypto';
import { BASTION_RULES as R, BASTION_ROLES, BASTION_SHOP, bastionWave, bastionReward, parseBastionPurchase } from '../../shared/bastion.js';
import { REACTOR_LAYOUT as L } from '../../shared/world/reactor-layout.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../shared/grenade-rules.js';
import { SX, SZ, createMapState } from '../../shared/worlddata.js';
import { BastionEnemies } from './bastion/enemies.js';

const slot = id => WEAPON_IDS.indexOf(id);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const point = p => ({ x:p.x,y:p.y,z:p.z });

/** Owns one finite cooperative run. Humans, NPCs and objectives have separate maps. */
export class BastionPolicy {
  constructor(context, engine) {
    Object.assign(this, { mode:'bastion', rules:context.rules, mapMeta:context.mapMeta,
      engine, players:new Map(), active:new Set(), ai:new BastionEnemies(engine,this) });
    this.reset(false);
  }
  get now() { return this.engine.now; }
  emit(kind, fields = {}) { this.engine.tickEvents.push({t:'ev',kind,at:this.now,...fields}); }
  reset(restoreWorld = true) {
    if (restoreWorld) {
      const fresh = createMapState('reactor');
      for (const i of this.engine.changedBlocks) {
        const x = i % SX, z = Math.floor(i / SX) % SZ, y = Math.floor(i / (SX * SZ));
        const value = fresh.getBlock(x,y,z);
        this.engine.world.setBlock(x,y,z,value);
        this.engine.tickBlocks.push({i,v:value});
      }
      this.engine.changedBlocks.clear();
      for (const row of this.engine.blockDamage.values()) this.engine.tickBlockDamage.set(`${row.x},${row.y},${row.z}`,{...row,progress:0});
      this.engine.blockDamage.clear(); this.engine.blockHp.clear(); this.engine.blockMining.clear();
    }
    this.run = randomUUID(); this.prep = 1; this.wave = 0; this.round = 1;
    this.phase = 'prep'; this.startedAt = this.now; this.phaseEndsAt = this.now + R.prepMs;
    this.credits = R.startCredits; this.upgrades = {}; this.armorBought = false;
    this.repairs = 0; this.repair = null; this.ready = new Set(); this.queue = [];
    this.killed = 0; this.total = 0; this.waveTeam = 0; this.laneIndex = 0;
    this.matchWinner = null; this.reason = null; this.returnAt = null; this.returnId = null;
    this.soloAvailable = true; this.soloUsed = false; this.supplyUsed = new Set();
    this.active.clear(); this.engine.npcs.clear(); this.clearHazards();
    this.core = { id:'bastion-core', objective:true, ...point(L.core), eyeY:L.core.y+1.8,
      combatBox:L.core.half, state:'alive', hp:R.coreHp, maxHp:R.coreHp, armor:0,
      takeDamage:(damage,_head,source) => {
        if (this.phase !== 'live' || !source?.npcRole || this.core.hp <= 0) return false;
        const amount = source.npcRole === 'breacher' ? damage * 80 / 70 : source.npcRole === 'heavy' ? Math.min(5,damage) : damage;
        const before = this.core.hp;
        this.core.hp = Math.max(0,before-amount);
        this.core.lastHit = {x:source.x,z:source.z,at:this.now};
        for (const threshold of [500,250]) if (before > threshold && this.core.hp <= threshold) this.emit('bastion_alarm',{hp:this.core.hp});
        return this.core.hp === 0;
      } };
    this.engine.objectives.set(this.core.id,this.core);
    for (const p of this.engine.entities.values()) {
      p.kills = p.deaths = p.score = 0;
      const state = this.players.get(p.id);
      if (state) { state.request = 0; this.active.add(p.id); this.resupply(p,50); }
    }
    if (this.active.size > 1) this.soloAvailable = false;
    this.ai.nav.version = -1;
  }
  clearHazards() {
    this.engine.projectiles.clear(); this.engine.flames.clear();
    this.emit('bastion_clear');
  }
  onPlayerAdd(p) {
    this.players.set(p.id,{primary:'rifle',throwable:'frag',request:0});
    p.team = 'alpha';
    if (this.phase === 'prep' || this.phase === 'supply') {
      this.active.add(p.id); this.resupply(p,this.wave === 0 ? 50 : 0);
      if (this.active.size > 1) this.soloAvailable = false;
    } else { p.state = 'dead'; p.hp = 0; p.respawnAt = Infinity; }
    return this.playerSnapshot(p);
  }
  onPlayerRemove(p) {
    this.players.delete(p.id); this.active.delete(p.id); this.ready.delete(p.id);
    if (this.repair?.id === p.id) this.repair = null;
    if (this.returnId === p.id) { this.returnAt = null; this.returnId = null; }
    if (!this.players.size && this.phase !== 'post') this.finish(false,'abandoned');
  }
  onPlayerDeath(p) {
    if (p.npcRole) { p.respawnAt = this.now + 1800; this.killed++; return true; }
    p.respawnAt = Infinity;
    if (this.phase === 'live' && this.waveTeam === 1 && this.soloAvailable && !this.soloUsed) {
      this.soloUsed = true; this.returnAt = this.now + R.returnMs; this.returnId = p.id;
      p.respawnAt = this.returnAt;
    }
    return true;
  }
  respawnDelay() { return Infinity; }
  canRespawn() { return false; }
  canTimedRespawn() { return false; }
  onPlayerRespawn() { return true; }
  teamFor(p) { return p?.npcRole ? 'bravo' : 'alpha'; }
  isEnemy(a,b) { return !!a && !!b && !!a.npcRole !== !!b.npcRole; }
  canDamage(a,b) {
    if (this.phase !== 'live' || !b || b.state !== 'alive') return false;
    if (a && b.spawnProtectedUntil > this.now) return false;
    if (b.objective) return !!a?.npcRole && (a.npcRole !== 'runner' || a.npcAttack === 'strike');
    return a == null ? !b.npcRole : a === b ? !b.npcRole : this.isEnemy(a,b);
  }
  canFire(p) { return this.phase === 'live' && p?.state === 'alive' && this.canUseWeapon(p,p.weapon); }
  canMove(p) { return p.state === 'alive' && this.phase !== 'post'; }
  canUseWeapon(p,weapon) {
    if (p?.npcRole) return true;
    const id = typeof weapon === 'string' ? weapon : WEAPON_IDS[weapon];
    return ['revolver','knife',this.players.get(p?.id)?.primary].includes(id);
  }
  chooseSpawn(p) {
    const candidates = L.defenders.map((spawn,index)=>({...spawn,index}));
    return this.engine.selectSafestSpawn(candidates,p,p?.lastSpawnIndex ?? -1);
  }
  resupply(p,armor) {
    this.engine.respawnPlayer(p,this.chooseSpawn(p),{protect:this.phase === 'live'});
    p.armor = armor; p.bastionUpgrades = {...this.upgrades};
    this.loadout(p); this.clearInput(p);
  }
  loadout(p) {
    const state = this.players.get(p.id); if (!state) return;
    p.owned = [state.primary,'revolver','knife']; p.weapon = slot(state.primary);
    p.mag = WEAPON_IDS.map(id=>p.owned.includes(id) ? WEAPONS[id].magSize : 0);
    p.reserve = WEAPON_IDS.map(id=>p.owned.includes(id)
      ? (WEAPONS[id].reloadStages ? WEAPONS[id].magSize : 1) * (3 + (this.upgrades.reserve ? 1 : 0)) : 0);
    p.grenades = GRENADE_TYPE_IDS.map(id=>id === 'smoke' || id === state.throwable ? 1 : 0);
  }
  clearInput(p) {
    p.input = null; p.triggerPrev = false; p.fireEdgeQueued = false; p.fireAimQueued = null;
    p.quickMeleeQueued = null; p.grenadeHandlingQueued = false; p.grenadeEdgeQueued = false;
    p.charging = false; p.charge = p.chargeT = 0;
  }
  beforeTick(dt) {
    if (this.phase === 'live') this.spawnGroup();
    this.ai.tick(dt);
  }
  tick() {
    if (this.phase === 'post') { if (this.players.size && this.now >= this.phaseEndsAt) this.reset(); return; }
    if (!this.players.size) { this.phaseEndsAt = this.now + R.prepMs; return; }
    if (this.phase !== 'live') {
      this.repairTick();
      if (this.now >= this.phaseEndsAt || (this.now-this.startedAt >= R.minimumPrepMs
          && this.active.size && [...this.active].every(id=>this.ready.has(id)))) this.startWave();
      return;
    }
    // Failure wins ties, including the tick that removes the final NPC.
    if (this.core.hp <= 0) { this.finish(false,'core'); return; }
    if (this.returnAt && this.now >= this.returnAt) {
      const p = this.engine.entities.get(this.returnId);
      if (p && this.active.has(p.id)) this.resupply(p,0);
      this.returnAt = null; this.returnId = null;
    }
    const alive = [...this.active].some(id=>this.engine.entities.get(id)?.state === 'alive');
    if (!alive && !this.returnAt) { this.finish(false,'team'); return; }
    this.supplyTick();
    if (!this.queue.length && !this.aliveEnemies().length && !this.returnAt) {
      if (this.wave === 8) { this.finish(true,'complete'); return; }
      this.credits += bastionReward(this.wave); this.beginSupply();
    }
  }
  aliveEnemies() { return [...this.engine.npcs.values()].filter(p=>p.state === 'alive'); }
  startWave() {
    if (!this.active.size || this.phase === 'live' || this.phase === 'post') return;
    this.wave++; this.round = this.wave; this.waveTeam = this.active.size;
    this.plan = bastionWave(this.wave,this.waveTeam);
    this.total = this.plan.total; this.killed = 0; this.queue = [];
    const counts = [...this.plan.counts];
    while (counts.some(n=>n>0)) for (let i=0;i<3;i++) if (counts[i] > 0) { this.queue.push(BASTION_ROLES[i]); counts[i]--; }
    this.phase = 'live'; this.phaseEndsAt = null; this.repair = null;
    this.supplyUsed.clear(); this.laneIndex = (this.wave-1)%3;
    this.nextSpawnAt = this.now + R.warningMs; this.nextLaneChangeAt = this.now + 18000;
    this.clearHazards(); for (const p of this.engine.entities.values()) { this.clearInput(p); p.bastionRelease = true; }
    this.emit('bastion_wave',{wave:this.wave,total:this.total});
  }
  spawnGroup() {
    if (!this.queue.length || this.now < this.nextSpawnAt) return;
    if (this.wave >= 3 && this.now >= this.nextLaneChangeAt) {
      this.laneIndex = (this.laneIndex+1)%3;
      this.nextSpawnAt = this.now + R.warningMs; this.nextLaneChangeAt = this.now + 18000;
      this.emit('bastion_lane',{lane:this.laneIndex}); return;
    }
    const alive = this.aliveEnemies(); let added = 0;
    for (let i=0;i<this.queue.length && added<R.groupSize && alive.length+added<this.plan.cap;) {
      const role = this.queue[i];
      if (role !== 'runner' && this.aliveEnemies().filter(p=>p.npcRole===role).length >= this.plan.specialCap) { i++; continue; }
      const lane = (this.laneIndex+added%this.plan.lanes)%3;
      this.ai.spawn(role,lane,added); this.queue.splice(i,1); added++;
    }
    this.nextSpawnAt = this.now + R.spawnIntervalMs;
  }
  beginSupply() {
    this.phase = 'supply'; this.prep++; this.startedAt = this.now; this.phaseEndsAt = this.now+R.supplyMs;
    this.ready.clear(); this.repairs = 0; this.repair = null; this.armorBought = false;
    this.engine.npcs.clear(); this.clearHazards();
    for (const p of this.engine.entities.values()) {
      const armor = this.active.has(p.id) && p.state === 'alive' ? p.armor : 0;
      this.active.add(p.id); this.resupply(p,armor);
    }
    if (this.active.size > 1) this.soloAvailable = false;
    this.emit('bastion_supply',{wave:this.wave,credits:this.credits});
  }
  finish(won,reason) {
    if (this.phase === 'post') return;
    this.phase = 'post'; this.phaseEndsAt = this.now+R.postMs; this.matchWinner = won ? 'alpha' : 'bravo';
    this.reason = reason; this.repair = null; this.returnAt = null;
    this.clearHazards(); for (const p of this.engine.entities.values()) this.clearInput(p);
    this.emit('match_end',{mode:this.mode,winner:this.matchWinner,reason,wave:this.wave});
  }
  buy(p,value) {
    if (typeof p !== 'object') p = this.engine.entities.get(String(p));
    const req = parseBastionPurchase(value), state = this.players.get(p?.id);
    if (!req || !state || p.state !== 'alive' || !['prep','supply'].includes(this.phase)
        || req.run !== this.run || req.prep !== this.prep || req.request <= state.request) return false;
    state.request = req.request;
    if (req.action === 'ready') { this.ready.add(p.id); return true; }
    if (req.action === 'loadout') {
      if (!WEAPON_IDS.includes(req.item) || ['knife','revolver'].includes(req.item)) return false;
      state.primary = req.item; this.loadout(p); return true;
    }
    if (req.action === 'throwable') {
      if (!GRENADE_TYPE_IDS.includes(req.item) || req.item === 'smoke') return false;
      state.throwable = req.item; this.loadout(p); return true;
    }
    const item = BASTION_SHOP[req.action];
    if (!item || this.availableCredits() < item.price) return false;
    if (req.action === 'armor') {
      const team = [...this.engine.entities.values()].filter(p=>this.active.has(p.id) && p.state === 'alive');
      if (this.armorBought || !team.some(p=>p.armor<100)) return false;
      for (const member of team) member.armor = Math.min(100,member.armor+50);
      this.armorBought = true;
    } else {
      if (this.upgrades[req.action]) return false;
      this.upgrades[req.action] = true;
      for (const member of this.engine.entities.values()) {
        member.bastionUpgrades = {...this.upgrades};
        if (req.action === 'reserve') this.loadout(member);
      }
    }
    this.credits -= item.price; this.emit('bastion_buy',{name:p.name,item:req.action,price:item.price}); return true;
  }
  availableCredits() { return this.credits-(this.repair ? R.repairPrice : 0); }
  repairTick() {
    if (this.repair) {
      const p = this.engine.entities.get(this.repair.id);
      if (!p || p.state !== 'alive' || !p.input?.keys?.interact || distance(p,this.core)>R.repairRadius) this.repair = null;
      else if (this.now-this.repair.at >= R.repairMs) {
        this.core.hp = Math.min(R.coreHp,this.core.hp+R.repairHp);
        this.credits -= R.repairPrice; this.repairs++; this.repair = null;
      }
    }
    if (this.repair || this.repairs>=R.repairLimit || this.core.hp>=R.coreHp || this.credits<R.repairPrice) return;
    for (const p of this.engine.entities.values()) if (p.state==='alive' && p.input?.keys?.interact && distance(p,this.core)<=R.repairRadius) {
      this.repair = {id:p.id,at:this.now}; break;
    }
  }
  supplyTick() {
    if (this.killed < Math.ceil(this.total/2)) return;
    for (const p of this.engine.entities.values()) {
      if (p.state !== 'alive' || this.supplyUsed.has(p.id) || distance(p,L.supply)>2.5) continue;
      p.hp = Math.min(100,p.hp+35);
      const primary = this.players.get(p.id)?.primary, i = slot(primary), def = WEAPONS[primary];
      if (i>=0) p.reserve[i] = Math.min(p.reserve[i]+(def.reloadStages?def.magSize:1),(def.reloadStages?def.magSize:1)*(3+(this.upgrades.reserve?1:0)));
      this.supplyUsed.add(p.id); this.emit('bastion_pickup',{id:p.id});
    }
  }
  playerSnapshot(p) {
    if (p.npcRole) return {team:'bravo',owned:[WEAPON_IDS[p.weapon]],npcRole:p.npcRole,npcAttack:p.npcAttack};
    const state = this.players.get(p.id);
    return {team:'alpha',credits:this.availableCredits(),owned:[state?.primary||'rifle','revolver','knife'],
      bastionUpgrades:{...this.upgrades},bastion:{ready:this.ready.has(p.id),waiting:!this.active.has(p.id),
        primary:state?.primary,throwable:state?.throwable,request:state?.request||0,supplyUsed:this.supplyUsed.has(p.id)},
      interaction:this.repair?.id === p.id ? {kind:'repair',progress:Math.min(1,(this.now-this.repair.at)/R.repairMs)} : null,
      spawnProtected:p.spawnProtectedUntil>this.now};
  }
  matchSnapshot() {
    return {mode:this.mode,map:'reactor',phase:this.phase,phaseEndsAt:this.phaseEndsAt,winner:this.matchWinner,round:this.wave||1,
      bastion:{run:this.run,prep:this.prep,wave:this.wave,waves:8,core:{...point(this.core),hp:this.core.hp,maxHp:R.coreHp,lastHit:this.core.lastHit||null},
        remaining:this.queue.length+this.aliveEnemies().length,alive:this.aliveEnemies().length,total:this.total,killed:this.killed,
        credits:this.availableCredits(),upgrades:{...this.upgrades},armorBought:this.armorBought,repairs:this.repairs,
        ready:this.ready.size,defenders:this.active.size,soloAvailable:this.soloAvailable&&!this.soloUsed,returnAt:this.returnAt,
        supply:{...point(L.supply),active:this.phase==='live'&&this.killed>=Math.ceil(this.total/2)},reason:this.reason,
        lanes:Array.from({length:this.plan?.lanes||1},(_,i)=>L.lanes[(this.laneIndex+i)%3].id),
        warningUntil:this.nextSpawnAt||0}};
  }
  botGoal() { return {kind:'spectate',target:null,interact:false}; }
  dispose() { this.engine.npcs.clear(); this.engine.objectives.clear(); this.players.clear(); }
}
