import { WEAPON_IDS } from '../../shared/combatmath.js';
import { CONQUEST_RULES } from '../../shared/conquest-contract.js';
import { buildCapturePresence, encodeConquestFlag, oppositeTeam } from '../../shared/conquest.js';
import { TdmPolicy } from './tdm.js';
import { weaponId } from './base-policy.js';
import { CaptureSystem } from './conquest/capture.js';
import { TicketLedger } from './conquest/tickets.js';
import { DeploySystem } from './conquest/deploy.js';
import { SquadRoster } from './conquest/squads.js';
import { ScoreLedger } from './conquest/score.js';
import { BoundsSystem, RESTRICTED_WEAPON } from './conquest/bounds.js';
import { createConquestRoles } from './conquest/roles.js';
import { kitUnlocked, unlockedKits } from '../../shared/conquest-kits.js';
import { FALL_DAMAGE, fallDamage, waterDepthAt } from '../../shared/parachute.js';
import { evHit } from '../protocol/events.js';

/** Kill key of a fall death (kill feed "FELL"); see shared/conquest-contract.js DEATH_KEYS. */
export const FALL_KILL_KEY = 'fall';
/** Kill key of an in-game menu RESPAWN (kill feed "REDEPLOYED"). */
export const REDEPLOY_KILL_KEY = 'redeploy';

/**
 * Battlefield-style Conquest: five flags with a majority-scaled control
 * scalar, majority ticket bleed, a time limit, HQ restriction and combat-area
 * bounds, a deploy-gated respawn (HQ, flags, squadmates, vehicle seats),
 * squads of four and a score ledger. Composed from server/modes/conquest/*.
 */
export class ConquestPolicy extends TdmPolicy {
  constructor(context, engine = null) {
    super(context);
    this.mode = 'conquest';
    this.engine = engine && typeof engine === 'object' ? engine : null;
    this.rules = Object.freeze({ ...CONQUEST_RULES, ...context.rules });
    this._resetVehicles = context.resetVehicles ?? (() => {});
    this._vehicleForContext = context.vehicleFor ?? (() => null);
    this.director = null;
    this.capture = new CaptureSystem(this.rules);
    this.ledger = new TicketLedger(this.rules);
    this.squads = new SquadRoster(this.rules.squadSize);
    this.bounds = new BoundsSystem(this.rules);
    this.deploy = new DeploySystem(this);
    this.score = new ScoreLedger({
      now: () => this.now,
      emit: (kind, fields) => this._emit(kind, fields),
      entity: value => this._entity(value),
      teamFor: p => this.teamFor(p),
      isEnemy: (a, b) => this.isEnemy(a, b),
      vehicleFor: id => this.vehicleFor(id),
      flags: () => this.capture.flags,
      rules: this.rules,
      damageTakenScale: (entity, weapon) => this.roles?.damageTakenScale?.(entity, weapon) ?? 1,
      onInfantryHit: (victim, attacker, weapon, amount) => this.roles?.onInfantryHit?.(victim, attacker, weapon, amount),
    });
    this.finalStats = new Map();
    this.roles = createConquestRoles({ policy: this, engine: this.engine, rules: this.rules });
    this._resetObjectives();
  }

  /**
   * Authoritative career level of a human (stamped by the lobby from the
   * player's server-side career, and on every level-up). Levels never drop.
   * Emits `kit_unlocks {id, level, unlocked, newly}` so the deploy screen
   * shows exactly the kits the server will accept; `announce` re-sends the
   * current state without a level change (match join and match start).
   */
  setCareerLevel(player, level, { announce = true } = {}) {
    const entity = this._entity(player);
    if (!entity || entity.bot) return null;
    // The first stamp of an entity (join, takeover, new match engine) only states the
    // level: a veteran is not "newly" unlocking anything. Only a later rise is news.
    const stamped = Number.isFinite(entity.careerLevel) && entity.careerLevel >= 1;
    const prior = stamped ? Math.trunc(entity.careerLevel) : 1;
    const next = Math.max(prior, Number.isFinite(level) && level >= 1 ? Math.trunc(level) : 1);
    entity.careerLevel = next;
    const unlocked = unlockedKits(next);
    const newly = stamped && next > prior ? unlocked.filter(kit => !kitUnlocked(kit, prior)) : [];
    if (announce || newly.length) this._emit('kit_unlocks', { id: String(entity.id), level: next, unlocked, newly });
    return { level: next, unlocked, newly };
  }

  /** Rich flag rows: id, x, y, z, radius, owner, control, state, mover, alpha, bravo, spawns. */
  get flags() { return this.capture.flags; }
  get tickets() { return this.ledger.tickets; }
  get vehicleSystem() { return this.engine?.vehicles ?? null; }
  get spawnSelector() { return this.engine?.spawnSelector ?? null; }

  vehicleFor(id) {
    if (id == null) return null;
    return this.engine?.vehicles?.vehicles?.get?.(String(id)) ?? this._vehicleForContext(String(id)) ?? null;
  }

  _resetObjectives() {
    const meta = this.mapMeta?.conquest;
    this.capture.reset(meta?.flags ?? []);
    this.ledger.reset(this.now);
    this.bounds.reset(meta);
    this.deploy.clearChoices?.();
    this.score.reset();
    this.finalStats = new Map();
    this.roles.reset();
    // Stable per match: the bot flex kit of each squad (shared/conquest-kits.js botSquadKit).
    this.kitSeed = Math.floor(Math.random() * 2 ** 31);
    for (const state of this._players.values()) state.objectiveId = null;
    this.lastTickAt = this.now;
    this._view = null;
    this._syncPads();
  }

  _syncPads() {
    const vehicles = this.vehicleSystem;
    if (typeof vehicles?.setPadOwner !== 'function') return;
    for (const flag of this.capture.flags) vehicles.setPadOwner(flag.id, flag.owner);
  }

  setBotDirector(director) {
    this.director = director && typeof director === 'object' ? director : null;
    this.reseedFreshBots();
    return true;
  }

  /**
   * Bots that spawned at HQ moments ago (round start before the director
   * registered, or while the bot roster was still filling) switch to the
   * director's squad slot kit for their opening life.
   */
  reseedFreshBots() {
    if (!this.director || this.phase !== 'live') return;
    for (const entity of this._entities.values()) {
      if (!entity.bot || entity.state !== 'alive' || !this._state(entity)) continue;
      if (this.deploy.seedBotKit(entity, { freshOnly: true })) this.applyRespawnLoadout(entity);
    }
  }

  // --- lifecycle -----------------------------------------------------------

  tick() {
    if (this.phase === 'post') { super.tick(); return; }
    const now = this.now;
    const dt = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    this._view = null;
    this._syncRevived();
    const presence = buildCapturePresence(this._entities.values(), {
      teamFor: p => this.teamFor(p),
      vehicleFor: id => this.vehicleFor(id),
      isDown: p => this.roles.isDown(p) === true,
    });
    for (const outcome of this.capture.step(dt, presence)) this._applyFlagOutcome(outcome);
    const held = this.capture.held();
    const { low, zero } = this.ledger.step(now, dt, held);
    for (const row of low) this._emit('ticket_low', row);
    if (zero) { this._finishMatch(oppositeTeam(zero)); return; }
    this.bounds.step(now, this._entities.values(), {
      teamFor: p => this.teamFor(p),
      vehicleFor: id => this.vehicleFor(id),
      kill: p => this._kill(p, RESTRICTED_WEAPON),
    });
    if (this.phase !== 'live') return;
    this.roles.tick(now, dt);
    this.score.tick(now);
    if (this.phase === 'live' && this.ledger.timeExpired(now)) this._finishMatch(this.ledger.timeLimitWinner(this.capture.held()));
  }

  /**
   * Revive hook (called by the roles package after it respawned the body at
   * the death position): clear the death bookkeeping without applying a
   * deploy choice, loadout or spawn protection.
   */
  onRevive(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;
    state.deathHandled = false;
    // The roles package keeps the kit the body died with; mirror it so a kit
    // picked on the deploy screen while down does not linger.
    this.deploy.onRevived(entity, this.roles.kitOf?.(entity) ?? null, this.roles.variantOf?.(entity) ?? 0, this.roles.gadgetOf?.(entity) ?? 0);
    this.bounds.clear(entity.id);
    return true;
  }

  /** Safety net for bodies respawned outside processRespawns without onRevive. */
  _syncRevived() {
    for (const [id, state] of this._players) {
      if (state.deathHandled && this._entities.get(id)?.state === 'alive') this.onRevive(this._entities.get(id));
    }
  }

  _applyFlagOutcome(outcome) {
    const { flag } = outcome;
    if (outcome.kind === 'state') {
      this._emit('flag_state', { flag: flag.id, state: outcome.state, team: outcome.team ?? null });
    } else if (outcome.kind === 'neutralized') {
      this._emit('flag_neutralized', { flag: flag.id, team: outcome.team, prev: outcome.prev });
      this.vehicleSystem?.setPadOwner?.(flag.id, null);
      for (const id of outcome.present) this.award(id, 'neutralize');
    } else if (outcome.kind === 'captured') {
      this._emit('flag_captured', { flag: flag.id, team: outcome.team });
      this.vehicleSystem?.setPadOwner?.(flag.id, outcome.team);
      for (const id of outcome.present) this.award(id, 'capture');
      for (const id of outcome.assists) if (this.teamFor(id) === outcome.team) this.award(id, 'capture_assist');
    } else if (outcome.kind === 'defended') {
      for (const id of outcome.defenders) if (this.teamFor(id) === outcome.team) this.award(id, 'defend');
    }
  }

  _kill(entity, weapon) {
    if (typeof this.engine?.killPlayer === 'function') { this.engine.killPlayer(entity, null, weapon, false); return; }
    if (entity.state !== 'alive') return;
    entity.hp = 0;
    entity.state = 'dead';
    entity.deaths = (entity.deaths | 0) + 1;
    this.onPlayerDeath(entity, null, { weapon });
  }

  _finishMatch(winner) {
    if (this.phase !== 'live') return;
    this.ledger.finish(this.now);
    this.finalStats = new Map([...this._players.keys()].map(id => [id, this.resultExtras(id)]));
    this.phase = 'post';
    this.phaseEndsAt = null; // ModeController sets it once the continuation vote passes
    this.matchWinner = winner ?? null;
    this._emit('match_end', { mode: this.mode, winner: this.matchWinner, scores: { ...this.ledger.tickets } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt });
  }

  reset() {
    // A rematch runs on the same engine: restore the terrain (craters under
    // flag and HQ spawn cells would otherwise wear spawns out across matches).
    // restoreWorld also resets the hulls to their conquest spawns.
    if (typeof this.engine?.restoreWorld === 'function') this.engine.restoreWorld();
    else this._resetVehicles();
    this._resetObjectives();
    super.reset();
    // A rematch re-sends every human's kit unlocks (the client HUD may have been rebuilt).
    for (const entity of this._entities.values()) if (!entity.bot && this._state(entity)) this.setCareerLevel(entity, entity.careerLevel);
  }

  // --- players -------------------------------------------------------------

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);
    const team = this._balancedTeam();
    const state = { team, deathHandled: false, objectiveId: null };
    this._players.set(id, state);
    this.squads.add(id, team);
    this.score.attach(entity);
    this._syncPlayer(entity, state);
    this._emit('team_assigned', { id, team });
    this._respawn(entity, { emitEvent: false });
    return this.playerSnapshot(entity);
  }

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    if (!super.onPlayerRemove(player)) return false;
    this.squads.remove(id);
    this.deploy.remove(id);
    this.bounds.clear(id);
    this.score.remove(id);
    if (entity) { this.score.detach(entity); this.roles.onRemove(entity); }
    return true;
  }

  onPlayerTakeover(player, nextId) {
    const entity = this._entity(player);
    const priorId = entity ? String(entity.id) : '';
    if (!super.onPlayerTakeover(player, nextId)) return false;
    const id = String(nextId);
    this.squads.rename(priorId, id);
    this.deploy.rename(priorId, id);
    this.bounds.rename(priorId, id);
    this.score.rename(priorId, id);
    this.roles.rename(priorId, id);
    return true;
  }

  setLobbyTeam(player, team) {
    if (!super.setLobbyTeam(player, team)) return false;
    const entity = this._entity(player);
    this.squads.add(String(entity.id), this.teamFor(entity));
    return true;
  }

  onPlayerDeath(victim, killer = null, context = {}) {
    if (this.phase !== 'live') return false;
    const dead = this._entity(victim);
    const state = this._state(dead);
    if (!state || state.deathHandled) return false;
    state.deathHandled = true;
    dead.respawnAt = this.now + this.respawnDelay();
    this.deploy.onDeath(dead);
    this.bounds.clear(dead.id);
    for (const row of this.ledger.charge(state.team, this.rules.deathTicketCost)) this._emit('ticket_low', row);
    this.score.onKill(dead, killer, context);
    this.roles.onDeath(dead, killer, context);
    // The deploy screen opens now: restate the human's kit unlocks, so a client that
    // missed the join announcement (still loading the map) never shows stale padlocks.
    if (!dead.bot && Number.isFinite(dead.careerLevel)) this.setCareerLevel(dead, dead.careerLevel);
    if (this.ledger.tickets[state.team] <= 0) this._finishMatch(oppositeTeam(state.team));
    return true;
  }

  /** Kill points are paid by the score ledger. */
  killScoreDelta() { return 0; }

  /**
   * Fall damage on landing (movement `onLand`, shared/parachute.js): damage
   * from the downward impact speed, none on deep water. A lethal fall within
   * FALL_DAMAGE.creditMs of enemy damage credits that enemy; otherwise it is a
   * self death. Both use the kill key `fall`. Returns the damage dealt.
   */
  fallDamage(player, speed) {
    const entity = this._entity(player);
    if (!entity || entity.state !== 'alive' || this.phase !== 'live' || entity.vehicleId) return 0;
    const damage = fallDamage(speed);
    if (!(damage > 0)) return 0;
    if (waterDepthAt(this.engine?.fluidAt, entity.x, entity.y, entity.z) >= FALL_DAMAGE.waterDepth) return 0;
    const lethal = entity.takeDamage(damage, false, null, FALL_KILL_KEY);
    this.engine?.tickEvents?.push(evHit('', entity.id, damage, false, [entity.x, entity.y + 0.2, entity.z], entity.lastDamage));
    if (lethal) {
      const credited = this.score.lastAttacker(entity.id, FALL_DAMAGE.creditMs);
      const killer = credited && this.isEnemy(credited, entity) ? credited : null;
      if (typeof this.engine?.killPlayer === 'function') this.engine.killPlayer(entity, killer, FALL_KILL_KEY, false);
      else this._kill(entity, FALL_KILL_KEY);
    }
    return damage;
  }

  /**
   * In-game menu RESPAWN (Battlefield redeploy): the living player dies where
   * they are, seated or not (the seat is released like any crew death and the
   * hull carries on; no exit or ejection first), with the kill key `redeploy`.
   * It is an ordinary death: 1 ticket, a death on the scoreboard, the deploy
   * screen and the normal respawn delay. The body cannot be revived. Damage
   * from an enemy within FALL_DAMAGE.creditMs credits that enemy, so a
   * redeploy never denies a kill; otherwise there is no killer. Refused while
   * dead or down, outside the live phase and within rules.redeployCooldownMs
   * of the last redeploy.
   */
  redeploy(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state || this.phase !== 'live' || entity.state !== 'alive' || this.roles.isDown?.(entity) === true) return false;
    if (this.now - (state.redeployAt ?? -Infinity) < this.rules.redeployCooldownMs) return false;
    state.redeployAt = this.now;
    const credited = this.score.lastAttacker(entity.id, FALL_DAMAGE.creditMs);
    const killer = credited && this.isEnemy(credited, entity) ? credited : null;
    if (typeof this.engine?.killPlayer === 'function') this.engine.killPlayer(entity, killer, REDEPLOY_KILL_KEY, false);
    else this._kill(entity, REDEPLOY_KILL_KEY);
    return entity.state !== 'alive';
  }

  /** No weapon fires under an open canopy or on the ejection seat. */
  canFire(player) {
    return !(this._entity(player)?.chute > 0) && super.canFire(player);
  }

  canTimedRespawn(player) {
    const entity = this._entity(player);
    return this.canRespawn(entity) && this.deploy.ready(entity);
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    return this.deploy.spawnPoint(entity, excludeIndex);
  }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;
    const resolved = this.deploy.consume(entity);
    state.deathHandled = false;
    this.bounds.clear(entity.id);
    this.applyRespawnLoadout(entity);
    this.deploy.finalize(entity, resolved);
    this.roles.onRespawn(entity);
    return true;
  }

  /** Round start, rematch and lobby team changes spawn at HQ at once. */
  _respawn(entity, { emitEvent = true } = {}) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, { emitEvent });
    const state = this._state(entity);
    if (!state) return;
    state.deathHandled = false;
    this.deploy.consume(entity);
    this.bounds.clear(entity.id);
    this.deploy.seedBotKit(entity);
    this.applyRespawnLoadout(entity);
    this.deploy.finalize(entity, null);
    this.roles.onRespawn(entity);
  }

  /** HQ spawn cells of a team. */
  hqPool(player) {
    const team = this.teamFor(player);
    const meta = this.mapMeta;
    const pool = meta?.spawns?.conquest?.[team];
    if (Array.isArray(pool) && pool.length) return pool;
    const base = meta?.conquest?.bases?.[team];
    if (Array.isArray(base?.spawns) && base.spawns.length) return base.spawns;
    return [base, ...(meta?.spawns?.fun ?? [])].filter(p => p && [p.x, p.y, p.z].every(Number.isFinite));
  }

  spawnPoolFor(player) { return this.hqPool(player); }

  applyRespawnLoadout(player) {
    if (!super.applyRespawnLoadout(player)) return false;
    const entity = this._entity(player);
    // A human who took over a bot inherits its kit choice: a class above the human's
    // career level falls back to the default here (rematch, team change, any respawn).
    this.deploy.enforceKitGate(entity);
    const { kit, variant, gadget } = this.deploy.kitOf(entity.id);
    this.roles.applyLoadout(entity, kit, variant, gadget);
    return true;
  }

  /** Kits narrow the arsenal to the owned list the roles package sets. */
  canUseWeapon(player, weapon) {
    const id = weaponId(weapon);
    if (!id) return false;
    const owned = this._entity(player)?.owned;
    return !Array.isArray(owned) || owned.includes(id);
  }

  // --- intents and hooks ---------------------------------------------------

  /** `{type:'deploy', spawn, kit, variant, gadget}` | `{type:'spot'}` | `{type:'support', support, targetId}` | `{type:'redeploy'}`. */
  conquestIntent(player, intent) {
    const entity = this._entity(player);
    if (!entity || !this._state(entity) || !intent || typeof intent !== 'object') return false;
    if (intent.type === 'deploy') return this.deploy.intent(entity, intent);
    if (intent.type === 'redeploy') return this.redeploy(entity);
    if ((intent.type === 'spot' || intent.type === 'support') && this.phase === 'live') {
      return this.roles.intent(entity, intent) === true;
    }
    return false;
  }

  onVehicleEvent(kind, payload) {
    if (this.phase !== 'live') return;
    this.score.onVehicleEvent(kind, payload);
    this.roles.onVehicleEvent(kind, payload);
  }

  refundTicket(team) { return this.ledger.refund(team, this.rules.deathTicketCost); }

  award(playerId, reason, scale = 1) {
    if (this.phase !== 'live') return 0;
    return this.score.award(playerId, reason, scale);
  }

  squadIdFor(player) { const e = this._entity(player); return e ? this.squads.squadOf(e.id) : 0; }
  restrictedMsFor(player) { const e = this._entity(player); return e ? this.bounds.restrictedMs(e.id, this.now) : 0; }
  restrictedMs(player) { return this.restrictedMsFor(player); }
  squadOf(player) { return this.squadIdFor(player); }
  kitFor(player) { const e = this._entity(player); return e ? this.deploy.kitOf(e.id) : null; }

  /** Server view for the shared deployOptions(). */
  deployView() {
    return {
      flags: this.capture.flags,
      players: [...this._entities.values()].filter(p => !p.npcRole).map(p => ({
        id: String(p.id), team: this.teamFor(p), state: p.state, x: p.x, y: p.y, z: p.z,
        vehicleId: typeof p.vehicleId === 'string' ? p.vehicleId : null, squad: this.squads.squadOf(p.id), bot: !!p.bot,
      })),
      vehicles: this.engine?.vehicles?.vehicles ? [...this.engine.vehicles.vehicles.values()] : [],
    };
  }

  /** Decoded-rich state for bots and roles, cached per tick. */
  conquestView() {
    if (this._view && this._view.at === this.now) return this._view.value;
    const value = {
      flags: this.capture.flags.map(f => {
        const [, , , , atk, def] = encodeConquestFlag(f);
        return { id: f.id, name: f.name, site: f.site, x: f.x, y: f.y, z: f.z, radius: f.radius, home: f.home,
          owner: f.owner, control: f.control, state: f.state, mover: f.mover, atk, def, alpha: f.alpha, bravo: f.bravo,
          spawns: f.spawns };
      }),
      tickets: { ...this.ledger.tickets },
      bleed: this.ledger.snapshotBleed(),
      endsAt: this.ledger.endsAt,
      squads: this.squads.map(),
      teamOf: p => this.teamFor(p),
      deployOptions: p => { const e = this._entity(p); return e && this._state(e) ? this.deploy.options(e) : []; },
    };
    this._view = { at: this.now, value };
    return value;
  }

  botGoal(player) {
    const p = this._entity(player);
    if (this.phase !== 'live' || p?.state !== 'alive') return { kind: 'spectate', target: null, interact: false };
    let directed = null;
    // A throwing director must never break the authoritative tick: use the fallback.
    try { directed = this.director?.goalFor?.(p) ?? null; } catch { directed = null; }
    if (directed && typeof directed === 'object') return directed;
    const team = this.teamFor(p);
    const state = this._state(p);
    const flags = this.capture.flags;
    const needsCapture = f => f.owner !== team || f.state === 'contested' || f.state === 'neutralizing';
    const current = flags.find(f => f.id === state?.objectiveId);
    if (current && needsCapture(current)) return { kind: 'capture', target: current, interact: false };
    const base = this.mapMeta?.conquest?.bases?.[team] ?? p;
    const ordered = flags.slice().sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z));
    const teammates = [...this._players.entries()].filter(([, s]) => s.team === team);
    const squadIndex = Math.max(0, teammates.findIndex(([id]) => id === String(p.id))) % Math.max(1, ordered.length);
    const preferred = ordered[squadIndex];
    const target = preferred && needsCapture(preferred) ? preferred
      : ordered.filter(needsCapture).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0]
        ?? preferred;
    if (state) state.objectiveId = target?.id ?? null;
    return { kind: 'capture', target: target ?? null, interact: false };
  }

  // --- snapshots -----------------------------------------------------------

  playerSnapshot(player) {
    const entity = this._entity(player);
    const base = super.playerSnapshot(player);
    if (!entity || !this._state(entity)) return base;
    return { ...base, owned: Array.isArray(entity.owned) ? entity.owned.slice() : WEAPON_IDS.slice(),
      conquest: this.conquestFields(entity) };
  }

  /** `p.conquest`: {kit, squad, down, spotted, restrictedMs, actionProgress, stats}; snapshot.js encodes cq/cqs. */
  conquestFields(entity) {
    const id = String(entity.id);
    const fields = { kit: this.deploy.kitOf(id).kit, squad: this.squads.squadOf(id), down: false, spotted: false,
      restrictedMs: this.bounds.restrictedMs(id, this.now), actionProgress: 0 };
    const extra = this.roles.snapshotFields(entity);
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) if (value !== undefined && key !== 'stats') fields[key] = value;
    }
    fields.stats = this.score.statsRow(id);
    return fields;
  }

  /** Per-player extras for the post-match results rows. */
  resultExtras(id) {
    const key = String(id);
    if (this.phase === 'post' && this.finalStats.has(key)) return this.finalStats.get(key);
    if (!this._players.has(key)) return null;
    return { cqs: this.score.statsRow(key), squad: this.squads.squadOf(key), kit: this.deploy.kitOf(key).kit };
  }

  matchSnapshot() {
    const ledger = this.ledger;
    return {
      ...super.matchSnapshot(),
      scores: { ...ledger.tickets },
      conquest: {
        v: 2,
        tickets: { ...ledger.tickets },
        maxTickets: ledger.max,
        bleed: ledger.snapshotBleed(),
        endsAt: Number.isFinite(ledger.endsAt) ? Math.round(ledger.endsAt) : null,
        flags: this.capture.flags.map(encodeConquestFlag),
        squads: this.squads.tuples(),
        ...(this.phase === 'post' ? { ticketGraph: ledger.graph.map(row => row.slice()) } : {}),
      },
    };
  }
}
