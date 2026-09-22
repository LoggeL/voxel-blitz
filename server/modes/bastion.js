import { randomUUID } from 'node:crypto';
import { BASTION_RULES as R, BASTION_ROLES, BASTION_ENEMIES, BASTION_SHOP, bastionWave, bastionReward, parseBastionPurchase } from '../../shared/bastion.js';
import { BASTION_LAYOUTS, bastionPlannedWaves } from '../../shared/world/bastion-layouts.js';
import { BASTION_BREAK_PHASES } from '../../shared/modes.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../shared/grenade-rules.js';
import { slot } from './bastion/ai-common.js';
import { BastionEnemies } from './bastion/enemies.js';
import { BastionStructures } from './bastion/structures.js';

const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const point = p => ({ x:p.x,y:p.y,z:p.z });
const APC = BASTION_ROLES.indexOf('apc');
const BREACH_EVENT_MS = 3000;
const LOOP_WARNING_MS = 3000;

/** Owns one finite cooperative run through the map's staged objectives. Humans, NPCs and objectives have separate maps. */
export class BastionPolicy {
  constructor(context, engine) {
    const mapMeta = context.mapMeta ?? { id:'reactor' };
    // A bare {id} meta (tests, older callers) resolves through the registry.
    const layout = mapMeta.bastion ?? BASTION_LAYOUTS[mapMeta.id];
    if (!layout) throw new RangeError(`no bastion layout for map ${mapMeta?.id}`);
    Object.assign(this, { mode:'bastion', rules:context.rules, mapMeta, layout, engine,
      players:new Map(), active:new Set(), tierSeen:new Set(), fuses:[], breachEmitAt:-Infinity,
      objective:null, stageIndex:0, stage:layout.stages[0], stageWave:0, waves:bastionPlannedWaves(layout) });
    this.structures = new BastionStructures(engine,this);
    this.ai = new BastionEnemies(engine,this);
    this.reset(false);
  }
  get now() { return this.engine.now; }
  /** Alias of the current stage objective (repair, HUD and older readers). */
  get core() { return this.objective; }
  /** `kind` is the event id on the wire; a payload's own `kind` (structure/vehicle/stage kind) travels as `type`. */
  emit(kind, fields = {}) {
    const { kind: type, ...rest } = fields;
    this.engine.tickEvents.push({t:'ev',kind,at:this.now,...rest,...(type !== undefined ? {type} : {})});
  }
  emitBreach(x,y,z,id) {
    if (this.now - this.breachEmitAt < BREACH_EVENT_MS) return;
    this.breachEmitAt = this.now; this.emit('bastion_breach',{x,y,z,id});
  }
  reset(restoreWorld = true) {
    if (restoreWorld) this.engine.restoreWorld();
    this.structures.clear(); this.engine.objectives.clear();
    this.run = randomUUID(); this.prep = 1; this.wave = 0; this.stageWave = 0; this.round = 1;
    this.phase = 'prep'; this.startedAt = this.now; this.phaseEndsAt = this.now + R.prepMs;
    this.credits = R.startCredits; this.upgrades = {}; this.armorBought = false;
    this.repairs = 0; this.repair = null; this.ready = new Set(); this.queue = [];
    this.killed = 0; this.total = 0; this.waveTeam = 0; this.plan = null; this.rowId = null;
    this.holdEndsAt = null; this.transition = null; this.held = []; this.tierSeen.clear(); this.fuses.length = 0;
    this.nextSpawnAt = 0; this.nextVehicleAt = 0;
    this.matchWinner = null; this.reason = null; this.returnAt = null; this.returnId = null;
    this.soloAvailable = true; this.soloUsed = false; this.supplyUsed = new Set();
    this.active.clear(); this.engine.npcs.clear(); this.clearHazards();
    this.setStage(0);
    for (const p of this.engine.entities.values()) {
      p.kills = p.deaths = p.score = 0; p.bastionBuild = null;
      const state = this.players.get(p.id);
      if (state) { state.request = 0; this.active.add(p.id); this.resupply(p,50); }
    }
    if (this.active.size > 1) this.soloAvailable = false;
  }
  /** Swap the live objective to stage `i`; the navigation goal and build budget follow. */
  setStage(i) {
    const stage = this.layout.stages[i]; if (!stage) return;
    if (this.objective) this.engine.objectives.delete(this.objective.id);
    this.stageIndex = i; this.stage = stage; this.stageWave = 0;
    this.objective = this.buildObjective(stage.objective);
    this.engine.objectives.set(this.objective.id,this.objective);
    this.ai.nav.goal = this.objective; this.ai.nav.version = -1;
    this.structures.onStageChange(i);
    this.emit('bastion_stage',{index:i,id:stage.id,name:stage.name,kind:stage.kind});
  }
  buildObjective(o) {
    const policy = this;
    return { id:`bastion-${o.id}`, objective:true, kind:'objective', name:o.name, model:o.model,
      x:o.x, y:o.y, z:o.z, eyeY:o.y+o.half[1], combatBox:[...o.half], half:[...o.half],
      state:'alive', hp:o.hp, maxHp:o.hp, armor:0, vx:0, vy:0, vz:0, yaw:0, pitch:0,
      lastDamage:null, lastHit:null, spawnProtectedUntil:0,
      takeDamage(damage,_head,source,weapon) {
        if (policy.phase !== 'live' || !source?.npcRole || this.hp <= 0) return false;
        const prof = BASTION_ENEMIES[source.npcRole];
        const amount = weapon === 'rocket' && prof.rocket ? damage * prof.objectiveHit / prof.damage
          : (prof.rusher && ['strike','slam'].includes(source.npcAttack)) ? damage
          : Math.min(prof.objectiveHit,damage);
        const before = this.hp; this.hp = Math.max(0,before-amount);
        this.lastHit = {x:source.x,z:source.z,at:policy.now};
        for (const f of [0.5,0.25]) if (before > this.maxHp*f && this.hp <= this.maxHp*f) policy.emit('bastion_alarm',{hp:this.hp});
        return this.hp === 0;
      } };
  }
  clearHazards() {
    this.engine.projectiles.clear(); this.engine.flames.clear(); this.fuses.length = 0;
    this.emit('bastion_clear');
  }
  onPlayerAdd(p) {
    this.players.set(p.id,{primary:'rifle',throwable:'frag',request:0});
    p.team = 'alpha'; p.bastionBuild = null;
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
    if (p.npcRole) {
      p.respawnAt = this.now + 1800; this.killed++;
      if (p.npcVehicle) {
        this.ai.dropTroops(p);
        this.emit('bastion_vehicle',{id:p.id,kind:p.npcRole,pos:[p.x,p.y,p.z],phase:'destroyed'});
      }
      return true;
    }
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
    if (b.objective) return !!a?.npcRole && (!!b.structure || !BASTION_ENEMIES[a.npcRole]?.rusher || ['strike','slam'].includes(a.npcAttack));
    if (a?.structure) return !!b.npcRole;
    return a == null ? !b.npcRole : a === b ? !b.npcRole : this.isEnemy(a,b);
  }
  canFire(p) { return this.phase === 'live' && p?.state === 'alive' && this.canUseWeapon(p,p.weapon); }
  canMove(p) { return p.state === 'alive' && this.phase !== 'post' && !p.npcVehicle; }
  canUseWeapon(p,weapon) {
    if (p?.npcRole) return true;
    const id = typeof weapon === 'string' ? weapon : WEAPON_IDS[weapon];
    return ['revolver','knife',this.players.get(p?.id)?.primary].includes(id);
  }
  chooseSpawn(p) {
    const candidates = this.stage.defenders.map((spawn,index)=>({...spawn,index}));
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
    this.structures.tick(dt);
    this.runFuses();
    this.ai.tick(dt);
  }
  /** Delayed detonations (walker mortar shells) keyed on the sim clock. */
  runFuses() {
    for (let i = this.fuses.length - 1; i >= 0; i--) {
      if (this.now < this.fuses[i].at) continue;
      const [fuse] = this.fuses.splice(i,1); fuse.fire();
    }
  }
  /** A mortar shell lands after the fuse: registered with the projectile system only at detonation. */
  fireMortar(walker, target) {
    const prof = BASTION_ENEMIES[walker.npcRole], m = prof.mortar, e = this.engine;
    const id = `mortar-${++this.ai.serial}`, [x,y,z] = target;
    const shell = { id, type:'rocket', owner:walker, ownerId:walker.id, x, y, z, vx:0, vy:0, vz:0, stuck:true,
      launchedAt:this.now, explodeAt:this.now + m.fuseMs, chaosLevel:0,
      blastRules:{ damage:m.damage, damageRadius:m.radius, damageFalloffExponent:1.15, selfDamage:0, knockback:20,
        terrainRadius:0, terrainPower:0, maxDestroyedBlocks:0, concussMs:0, concussPanic:0 } };
    this.emit('bastion_charge',{id:walker.id,pos:[x,y,z]});
    this.fuses.push({ at:this.now + m.fuseMs, fire:() => {
      if (this.phase !== 'live') return;
      e.projectiles.active.set(id,shell); e.projectiles.explode(shell,e.contexts.projectiles);
    } });
  }
  tick() {
    if (this.phase === 'post') { if (this.players.size && Number.isFinite(this.phaseEndsAt) && this.now >= this.phaseEndsAt) this.reset(); return; }
    if (!this.players.size) { this.phaseEndsAt = this.now + R.prepMs; return; }
    if (this.phase !== 'live') {
      this.repairTick();
      if (this.now >= this.phaseEndsAt || (this.now-this.startedAt >= R.minimumPrepMs
          && this.active.size && [...this.active].every(id=>this.ready.has(id)))) this.startWave();
      return;
    }
    // Failure wins ties, including the tick that removes the final NPC.
    if (this.objective.hp <= 0) { this.finish(false,'objective'); return; }
    if (this.returnAt && this.now >= this.returnAt) {
      const p = this.engine.entities.get(this.returnId);
      if (p && this.active.has(p.id)) this.resupply(p,0);
      this.returnAt = null; this.returnId = null;
    }
    const alive = [...this.active].some(id=>this.engine.entities.get(id)?.state === 'alive');
    if (!alive && !this.returnAt) { this.finish(false,'team'); return; }
    this.supplyTick();
    if (this.stage.kind === 'extract' && this.holdEndsAt !== null && this.now >= this.holdEndsAt) {
      const obj = this.objective, radius = this.stage.extractRadius ?? 8;
      const held = obj.hp > 0 && [...this.active].some(id=>{
        const p = this.engine.entities.get(id);
        return p?.state === 'alive' && Math.hypot(p.x-obj.x,p.z-obj.z) <= radius;
      });
      if (held) { this.finish(true,'extracted'); return; }
      if (this.now >= this.holdEndsAt + R.extractGraceMs) { this.finish(false,'missed'); return; }
    }
    if (!this.queue.length && !this.aliveEnemies().length && !this.returnAt) {
      if (this.stage.kind === 'hold') {
        this.credits += bastionReward(this.wave);
        if (this.stageWave >= this.stage.waves.length) {
          this.credits += R.stageBonus; this.held.push(this.stage.id);
          if (!this.layout.stages[this.stageIndex+1]) { this.finish(true,'extracted'); return; }
          this.setStage(this.stageIndex+1); this.beginSupply('regroup');
        } else this.beginSupply(null);
      } else {
        // Extraction never pauses: the next row queues up under the same clock.
        this.startWaveRow(); this.nextSpawnAt = this.now + LOOP_WARNING_MS;
        this.structures.crateUsed.clear(); this.structures.refillTurrets();
        this.emit('bastion_wave',{wave:this.wave,total:this.total,stage:this.stageIndex,row:this.rowId});
      }
    }
  }
  aliveEnemies() { return [...this.engine.npcs.values()].filter(p=>p.state === 'alive'); }
  /** Queue the next row of the current stage: round-robin over roles, vehicles behind the infantry. */
  startWaveRow() {
    this.wave++; this.stageWave++; this.round = this.wave; this.waveTeam = this.active.size;
    const rowId = this.stage.waves[this.stageWave-1] ?? this.stage.loop ?? this.stage.waves.at(-1);
    this.plan = bastionWave(rowId,this.waveTeam); this.rowId = rowId;
    this.total = this.plan.total + this.plan.counts[APC] * BASTION_ENEMIES.apc.drop.count; this.killed = 0;
    const counts = [...this.plan.counts], infantry = [], vehicles = [];
    while (counts.some(n=>n>0)) for (let i=0;i<BASTION_ROLES.length;i++) if (counts[i] > 0) {
      (BASTION_ENEMIES[BASTION_ROLES[i]].vehicle ? vehicles : infantry).push(BASTION_ROLES[i]); counts[i]--;
    }
    if (rowId === 'lastStand') { const at = Math.ceil(infantry.length/3); this.queue = [...infantry.slice(0,at),...vehicles,...infantry.slice(at)]; }
    else this.queue = [...infantry,...vehicles];
  }
  startWave() {
    if (!this.active.size || this.phase === 'live' || this.phase === 'post') return;
    this.startWaveRow();
    this.phase = 'live'; this.phaseEndsAt = null; this.repair = null; this.transition = null;
    this.supplyUsed.clear(); this.structures.crateUsed.clear(); this.structures.refillTurrets();
    this.nextSpawnAt = this.now + R.warningMs; this.nextVehicleAt = this.now;
    if (this.stage.kind === 'extract' && this.holdEndsAt === null) {
      this.holdEndsAt = this.now + (this.stage.holdMs ?? 150000); this.emit('bastion_extract',{endsAt:this.holdEndsAt});
    }
    this.clearHazards(); for (const p of this.engine.entities.values()) { this.clearInput(p); p.bastionRelease = true; }
    this.emit('bastion_wave',{wave:this.wave,total:this.total,stage:this.stageIndex,row:this.rowId});
    this.emit('bastion_lane',{lane:this.stage.lane});
  }
  spawnGroup() {
    if (!this.queue.length || this.now < this.nextSpawnAt) return;
    const alive = this.aliveEnemies(); let added = 0;
    const aliveVehicles = alive.filter(p=>p.npcVehicle).length;
    for (let i=0;i<this.queue.length && added<R.groupSize && alive.length+added<this.plan.cap;) {
      const role = this.queue[i];
      if (BASTION_ENEMIES[role].vehicle) {
        if (aliveVehicles >= this.plan.vehicleCap || this.now < this.nextVehicleAt) { i++; continue; }
        // Vehicles roll in alone on the stage route and close the group.
        this.ai.spawn(role,this.stageIndex,0); this.queue.splice(i,1); added++;
        this.nextVehicleAt = this.now + R.vehicleIntervalMs; break;
      }
      if (role !== 'runner' && this.aliveEnemies().filter(p=>p.npcRole===role).length >= this.plan.specialCap) { i++; continue; }
      this.ai.spawn(role,this.stageIndex,added); this.queue.splice(i,1); added++;
    }
    this.nextSpawnAt = this.now + R.spawnIntervalMs;
  }
  beginSupply(transition = null) {
    this.phase = 'supply'; this.prep++; this.startedAt = this.now; this.transition = transition;
    this.phaseEndsAt = this.now + (transition === 'regroup' ? R.regroupMs : R.supplyMs);
    this.ready.clear(); this.repairs = 0; this.repair = null; this.armorBought = false;
    this.engine.npcs.clear(); this.clearHazards(); this.structures.refillAll();
    for (const p of this.engine.entities.values()) {
      const armor = this.active.has(p.id) && p.state === 'alive' ? p.armor : 0;
      this.active.add(p.id); this.resupply(p,armor);
    }
    if (this.active.size > 1) this.soloAvailable = false;
    if (transition === 'regroup') this.emit('bastion_regroup',{index:this.stageIndex,
      next:{id:this.stage.id,name:this.stage.name,x:this.stage.objective.x,z:this.stage.objective.z},until:this.phaseEndsAt});
    this.emit('bastion_supply',{wave:this.wave,credits:this.credits});
  }
  finish(won,reason) {
    if (this.phase === 'post') return;
    this.phase = 'post'; this.phaseEndsAt = null; this.matchWinner = won ? 'alpha' : 'bravo';
    this.reason = reason; this.repair = null; this.returnAt = null;
    this.clearHazards(); for (const p of this.engine.entities.values()) this.clearInput(p);
    this.emit('match_end',{mode:this.mode,winner:this.matchWinner,reason,wave:this.wave,stage:this.stageIndex});
  }
  buy(p,value) {
    if (typeof p !== 'object') p = this.engine.entities.get(String(p));
    const req = parseBastionPurchase(value), state = this.players.get(p?.id);
    if (!req || !state || p.state !== 'alive' || !BASTION_BREAK_PHASES.includes(this.phase)
        || req.run !== this.run || req.prep !== this.prep || req.request <= state.request) return false;
    state.request = req.request;
    if (req.action === 'ready') { this.ready.add(p.id); return true; }
    if (req.action === 'build') return this.structures.place(p,req);
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
    const obj = this.objective;
    if (this.repair) {
      const p = this.engine.entities.get(this.repair.id);
      if (!p || p.state !== 'alive' || !p.input?.keys?.interact || distance(p,obj)>R.repairRadius) this.repair = null;
      else if (this.now-this.repair.at >= R.repairMs) {
        obj.hp = Math.min(obj.maxHp,obj.hp+R.repairHp);
        this.credits -= R.repairPrice; this.repairs++; this.repair = null;
      }
    }
    if (this.repair || this.repairs>=R.repairLimit || obj.hp>=obj.maxHp || this.credits<R.repairPrice) return;
    for (const p of this.engine.entities.values()) if (p.state==='alive' && p.input?.keys?.interact && distance(p,obj)<=R.repairRadius) {
      this.repair = {id:p.id,at:this.now}; break;
    }
  }
  supplyTick() {
    if (this.killed < Math.ceil(this.total/2)) return;
    for (const p of this.engine.entities.values()) {
      if (p.state !== 'alive' || this.supplyUsed.has(p.id) || distance(p,this.stage.supply)>2.5) continue;
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
        primary:state?.primary,throwable:state?.throwable,request:state?.request||0,supplyUsed:this.supplyUsed.has(p.id),
        build:p.bastionBuild ? {...p.bastionBuild} : null},
      interaction:this.repair?.id === p.id ? {kind:'repair',progress:Math.min(1,(this.now-this.repair.at)/R.repairMs)} : null,
      spawnProtected:p.spawnProtectedUntil>this.now};
  }
  matchSnapshot() {
    const stage = this.stage, obj = this.objective, alive = this.aliveEnemies(), next = this.layout.stages[this.stageIndex+1];
    return {mode:this.mode,map:this.mapMeta.id,phase:this.phase,phaseEndsAt:this.phaseEndsAt,winner:this.matchWinner,round:this.wave||1,
      bastion:{run:this.run,prep:this.prep,wave:this.wave,waves:this.waves,
        stage:{index:this.stageIndex,count:this.layout.stages.length,id:stage.id,name:stage.name,kind:stage.kind,lane:stage.lane,
          wave:this.stageWave,waves:stage.waves.length,transition:this.transition,holdEndsAt:this.holdEndsAt,
          extractRadius:stage.extractRadius ?? null,buildZone:{...stage.buildZone},
          next:stage.kind === 'hold' && next ? {id:next.id,name:next.name,x:next.objective.x,z:next.objective.z} : null},
        core:{id:obj.id,name:obj.name,model:obj.model,...point(obj),half:[...obj.half],hp:obj.hp,maxHp:obj.maxHp,lastHit:obj.lastHit||null},
        held:[...this.held],
        remaining:this.queue.length+alive.length,alive:alive.length,total:this.total,killed:this.killed,
        credits:this.availableCredits(),upgrades:{...this.upgrades},armorBought:this.armorBought,repairs:this.repairs,
        ready:this.ready.size,defenders:this.active.size,soloAvailable:this.soloAvailable&&!this.soloUsed,returnAt:this.returnAt,
        supply:{...point(stage.supply),active:this.phase==='live'&&this.killed>=Math.ceil(this.total/2)},
        lanes:[stage.lane],reason:this.reason,warningUntil:this.nextSpawnAt||0,
        structures:this.structures.rows(),budget:this.structures.budget(),
        vehicles:alive.filter(v=>v.npcVehicle).map(v=>({id:v.id,kind:v.npcRole}))}};
  }
  botGoal() { return {kind:'spectate',target:null,interact:false}; }
  dispose() { this.engine.npcs.clear(); this.engine.objectives.clear(); this.players.clear(); }
}
