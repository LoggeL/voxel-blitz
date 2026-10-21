import { WEAPON_IDS } from '../../shared/combatmath.js';
import { CONQUEST_RULES } from '../../shared/conquest-contract.js';
import { buildCapturePresence, encodeConquestFlag, oppositeTeam } from '../../shared/conquest.js';
import { TdmPolicy } from './tdm.js';
import { weaponId } from './base-policy.js';
import { CaptureSystem } from './conquest/capture.js';
import { FlagCaches } from './conquest/flag-caches.js';
import { TicketLedger } from './conquest/tickets.js';
import { DeploySystem } from './conquest/deploy.js';
import { SquadRoster } from './conquest/squads.js';
import { ScoreLedger } from './conquest/score.js';
import { RibbonTracker } from './conquest/ribbons.js';
import { BoundsSystem, RESTRICTED_WEAPON } from './conquest/bounds.js';
import { airspaceFor, airspaceRect } from '../../shared/world/airspace.js';
import { createConquestRoles } from './conquest/roles.js';
import { SquadOrders } from './conquest/orders.js';
import { CommSystem } from './conquest/comms.js';
import { ReconGadgets } from './conquest/recon-gadgets.js';
import { AmmoPouches } from './conquest/pouches.js';
import { SupplyCrates } from './conquest/supply-crates.js';
import { ConquestUpgrades } from './conquest/upgrades.js';
import { ConquestWeather, weatherOptionFromEnv } from './conquest/weather.js';
import { kitUnlocked, unlockedKits } from '../../shared/conquest-kits.js';
import { FALL_DAMAGE, fallDamage, waterDepthAt } from '../../shared/parachute.js';
import { evHit } from '../protocol/events.js';
import { interruptMedkit } from '../sim/medkit.js';
import { mortarIntent } from './conquest/mortar-intent.js';
import { fpvField, fpvIntent, fpvLoadout, fpvOperating, fpvRemoveOwner, fpvRename } from './conquest/fpv-intent.js';
import { IronBridge } from './conquest/bridge.js';
import { MapEventSystem, mapEventsOptionFromEnv } from './conquest/map-events/system.js';
import { MAP_EVENT_SUPPORT } from '../../shared/conquest-map-events.js';
import { interactKindOfVerb } from '../../shared/interact-anim.js';

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
    this.ledger = this._createLedger();
    this.squads = new SquadRoster(this.rules.squadSize);
    this.bounds = this._createBounds();
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
      onAward: (id, reason) => { if (reason !== 'ribbon') this.ribbons.onAward(id, reason); },
    });
    this.ribbons = new RibbonTracker({ ribbon: (id, ribbon, count) => this._payRibbon(id, ribbon, count) });
    this.finalStats = new Map();
    // Recon spawn beacons and motion sensors (docs/conquest.md "Recon gadgets").
    this.reconGadgets = new ReconGadgets(this);
    // Ammo pouches dropped by the fallen (docs/conquest.md "Infantry supply").
    this.pouches = new AmmoPouches(this);
    // Support AMMO CRATE and Medic MEDICAL CRATE (docs/conquest.md "Infantry supply").
    this.supplyCrates = new SupplyCrates(this);
    this.roles = createConquestRoles({ policy: this, engine: this.engine, rules: this.rules });
    // Squad orders and the comm rose (shared/conquest-comms.js).
    this.squadOrders = new SquadOrders({
      now: () => this.now,
      emit: (kind, fields) => this._emit(kind, fields),
      squads: this.squads,
      flags: () => this.capture.flags,
      locked: flag => !!this.capture.locked?.(flag),
      teamFor: p => this.teamFor(p),
      entity: value => this._entity(value),
    });
    this.comms = new CommSystem(this);
    // Flag supply caches (conquest/flag-caches.js): the holder's soldiers restock at their flags.
    this.flagCaches = new FlagCaches(this);
    this.upgrades = new ConquestUpgrades(this);
    // Dynamic weather (conquest/weather.js): the mode rule `weather`, else VB_CONQUEST_WEATHER
    // ('off', or a state id such as 'storm' to pin it), else a seeded timeline per match.
    const envWeather = typeof process !== 'undefined' ? weatherOptionFromEnv(process.env?.VB_CONQUEST_WEATHER) : undefined;
    this.weather = new ConquestWeather({ option: context.rules?.weather ?? envWeather ?? true,
      durationMs: this.rules.timeLimitMs, area: this.mapMeta?.conquest?.combatArea ?? null });
    // Frontier's Iron Bridge levolution (inert on worlds without the bridge).
    this.bridge = new IronBridge({ engine: () => this.engine, now: () => this.now, emit: (kind, fields) => this._emit(kind, fields),
      award: (id, reason) => this.award(id, reason), canDamage: (a, b) => this.canDamage(a, b) });
    // Map events (conquest/map-events/): the mode rule `mapEvents` (false: off, or a list of
    // definitions for fixtures), else VB_CONQUEST_EVENTS ('off'), else the registry's events of the map.
    const envEvents = typeof process !== 'undefined' ? mapEventsOptionFromEnv(process.env?.VB_CONQUEST_EVENTS) : undefined;
    this.mapEvents = new MapEventSystem(this, { defs: context.rules?.mapEvents ?? envEvents,
      ...(context.rules?.mapEventControllers ? { controllers: context.rules.mapEventControllers } : {}) });
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

  /** Every Conquest event also reaches the comm rose (a heal or revive serves NEED MEDIC; a human order earns a bot AFFIRMATIVE). */
  _emit(kind, fields = {}) {
    super._emit(kind, fields);
    this.comms?.onEvent(kind, fields);
    if (kind === 'squad_order') this.comms?.orderIssued(fields);
  }

  /**
   * Authoritative career progress of a human for the result screen: `xp` is the
   * profile total (stamped at admission, then pushed by the career service after
   * every saved reward), `gained` the XP this match earned so far. XP never drops.
   */
  setCareerProgress(player, { xp, gained } = {}) {
    const entity = this._entity(player);
    if (!entity || entity.bot || !Number.isFinite(xp)) return false;
    entity.careerXp = Math.max(Number.isFinite(entity.careerXp) ? entity.careerXp : 0, Math.trunc(xp));
    if (Number.isFinite(gained)) entity.careerMatchXp = Math.max(0, Math.trunc(gained));
    return true;
  }

  /** A ribbon (RibbonTracker): pay SCORE_POINTS.ribbon and announce it. */
  _payRibbon(id, ribbon, count) {
    const pts = this.award(id, 'ribbon');
    this._emit('ribbon', { id: String(id), ribbon, count, pts });
  }
  // --- variant hooks (server/modes/conquest/breakthrough.js overrides them) ---

  /** Rule variant (CONQUEST_VARIANTS); the mode id stays 'conquest'. */
  get variant() { return 'conquest'; }
  /** Ticket accounting; called once from the constructor (before subclass fields exist). */
  _createLedger() { return new TicketLedger(this.rules); }
  /** HQ restriction and combat area; called once from the constructor. */
  _createBounds() { return new BoundsSystem(this.rules); }
  /** Hull spawns of a match (GameEngine resets the VehicleSystem with them). */
  vehicleSpawns() { return this.mapMeta?.conquest?.vehicleSpawns ?? []; }
  /** After every capture step, before tickets: objective rules beyond the flags. */
  _afterCapture() {}
  /** A team ran out of tickets: it loses. */
  _onTicketsOut(team) { this._finishMatch(oppositeTeam(team)); }
  /** Extra `match.conquest` fields of a variant. */
  _conquestExtras() { return null; }
  /** Extra `match_end` fields of a variant. */
  _matchEndExtras() { return null; }

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
    this.weather?.reset(this.ledger.startedAt);
    this.bounds.reset(meta, { airArea: this._airArea() });
    this.deploy.clearChoices?.();
    this.score.reset();
    this.ribbons.reset();
    this.finalStats = new Map();
    this.roles.reset();
    this.squadOrders?.reset();
    this.comms?.reset();
    this.reconGadgets.reset();
    this.pouches?.reset();
    this.supplyCrates.reset();
    this.flagCaches?.reset();
    this.upgrades.reset();
    this.bridge?.reset();
    this.mapEvents?.reset();
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
    this._holdDeployClock();
    const presence = buildCapturePresence(this._entities.values(), {
      teamFor: p => this.teamFor(p),
      vehicleFor: id => this.vehicleFor(id),
      isDown: p => this.roles.isDown(p) === true,
    });
    for (const outcome of this.capture.step(dt, presence)) this._applyFlagOutcome(outcome);
    this._afterCapture(now);
    if (this.phase !== 'live') return;
    const held = this.capture.held();
    const { low, zero } = this.ledger.step(now, dt, held);
    for (const row of low) this._emit('ticket_low', row);
    if (zero) { this._onTicketsOut(zero); if (this.phase !== 'live') return; }
    this.bounds.step(now, this._entities.values(), {
      teamFor: p => this.teamFor(p),
      vehicleFor: id => this.vehicleFor(id),
      kill: (p, aircraft) => aircraft ? this._loseAircraft(aircraft, p) : this._kill(p, RESTRICTED_WEAPON),
    });
    if (this.phase !== 'live') return;
    this.upgrades.tick();
    this._stepWeather(now);
    this.bridge.tick(now);
    this.mapEvents.tick(now, dt);
    if (this.phase !== 'live') return;
    this.roles.tick(now, dt);
    this.flagCaches.tick(now);
    this.squadOrders.sync();
    this.comms.tick(now);
    this.reconGadgets.tick(now);
    this.pouches.tick(now, this._entities.values());
    this.supplyCrates.tick(now);
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
    state.deployHeld = false;
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
      for (const id of outcome.present) {
        this.award(id, 'capture');
        if (this._onOrder(id, flag)) this.award(id, 'order_capture');
      }
      for (const id of outcome.assists) if (this.teamFor(id) === outcome.team) this.award(id, 'capture_assist');
    } else if (outcome.kind === 'defended') {
      for (const id of outcome.defenders) {
        if (this.teamFor(id) !== outcome.team) continue;
        this.award(id, 'defend');
        if (this._onOrder(id, flag)) this.award(id, 'order_defend');
      }
    }
  }

  /** True when the player's squad is ordered onto `flag` (the order bonus on a capture or defend). */
  _onOrder(id, flag) {
    return this.squadOrders.orderOf(id)?.flagId === flag.id;
  }

  /** Combat airspace of the map (its airspace apron's combat gap), or null. */
  _airArea() {
    const space = airspaceFor(this.mapMeta?.id), d = this.mapMeta?.dimensions;
    return space && d ? airspaceRect(d, space.combat) : null;
  }

  /** An aircraft whose crew stayed out of the combat airspace is destroyed with its crew. */
  _loseAircraft(hull, entity) {
    const vehicles = this.engine?.vehicles;
    if (typeof vehicles?.destroy === 'function' && hull.hp > 0) vehicles.destroy(hull, null, { crewKey: RESTRICTED_WEAPON });
    if (entity.state === 'alive') this._kill(entity, RESTRICTED_WEAPON);
  }

  _kill(entity, weapon) {
    if (typeof this.engine?.killPlayer === 'function') { this.engine.killPlayer(entity, null, weapon, false); return; }
    if (entity.state !== 'alive') return;
    entity.hp = 0;
    entity.state = 'dead';
    entity.deaths = (entity.deaths | 0) + 1;
    this.onPlayerDeath(entity, null, { weapon });
  }

  /** Advance the weather; each due lightning strike becomes `weather_strike {x, y, z}` (y: the ground under it). */
  _stepWeather(now) {
    for (const strike of this.weather.step(now)) {
      const solidAt = this.engine?.solidAt;
      let y = 0;
      if (typeof solidAt === 'function') {
        for (let probe = 120; probe > 0; probe--) if (solidAt(strike.x, probe - 1, strike.z)) { y = probe; break; }
      }
      this._emit('weather_strike', { x: strike.x, y, z: strike.z });
    }
  }

  /**
   * Gameplay multipliers of the current weather (shared/conquest-weather.js
   * decodeConquestWeather of the snapshot tuple; CALM_WEATHER while off):
   * spot, lock, vision, recognition and the canopy `drift {x, z}`.
   */
  weatherEffects() { return this.weather.effects; }

  _finishMatch(winner) {
    if (this.phase !== 'live') return;
    this.ledger.finish(this.now);
    this.reconGadgets.reset();
    this.pouches.reset();
    this.supplyCrates.reset();
    // Medals from the match's ribbons, decided before the results rows freeze.
    for (const [id, medal] of this.ribbons.finish(this._players.keys())) this._emit('medal', { id, medal });
    this.finalStats = new Map([...this._players.keys()].map(id => [id, this.resultExtras(id)]));
    this.phase = 'post';
    this.phaseEndsAt = null; // ModeController sets it once the continuation vote passes
    this.matchWinner = winner ?? null;
    this._emit('match_end', { mode: this.mode, winner: this.matchWinner, scores: { ...this.ledger.tickets }, ...this._matchEndExtras() });
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
    for (const entity of this._entities.values()) if (Number.isFinite(entity.careerMatchXp)) entity.careerMatchXp = 0;
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
    this.squadOrders.remove(id);
    this.comms.remove(id);
    this.reconGadgets.removeOwner(id);
    this.supplyCrates.removeOwner(id);
    fpvRemoveOwner(this, id);
    this.ribbons.remove(id);
    this.mapEvents.remove(id);
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
    this.ribbons.rename(priorId, id);
    this.roles.rename(priorId, id);
    this.squadOrders.rename(priorId, id);
    this.comms.rename(priorId, id);
    this.reconGadgets.rename(priorId, id);
    this.supplyCrates.rename(priorId, id);
    this.mapEvents.rename(priorId, id);
    fpvRename(this, priorId, id);
    return true;
  }

  setLobbyTeam(player, team) {
    if (!super.setLobbyTeam(player, team)) return false;
    const entity = this._entity(player);
    this.squads.add(String(entity.id), this.teamFor(entity));
    this.reconGadgets.removeOwner(entity.id);
    this.supplyCrates.removeOwner(entity.id);
    fpvRemoveOwner(this, entity.id);
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
    fpvRemoveOwner(this, dead.id);
    this.supplyCrates.onDeath(dead);
    for (const row of this.ledger.charge(state.team, this.rules.deathTicketCost)) this._emit('ticket_low', row);
    this.score.onKill(dead, killer, context);
    this.ribbons.onDeath(dead.id);
    this.pouches.onDeath(dead, context);
    this.roles.onDeath(dead, killer, context);
    // The deploy screen opens now: restate the human's kit unlocks, so a client that
    // missed the join announcement (still loading the map) never shows stale padlocks.
    if (!dead.bot && Number.isFinite(dead.careerLevel)) this.setCareerLevel(dead, dead.careerLevel);
    if (this.ledger.tickets[state.team] <= 0) this._onTicketsOut(state.team);
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

  /** No weapon fires under an open canopy, on the ejection seat or while flying an FPV drone. */
  canFire(player) {
    return !(this._entity(player)?.chute > 0) && !fpvOperating(this, this._entity(player)) && super.canFire(player);
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
    state.deployHeld = false;
    this.bounds.clear(entity.id);
    this.applyRespawnLoadout(entity);
    this.deploy.finalize(entity, resolved);
    this.roles.onRespawn(entity);
    return true;
  }

  /**
   * Network humans never spawn without a deploy choice. The lobby gates every
   * admission (lobby join, mid-match join, bot takeover): instead of the
   * immediate HQ spawn of a join, lobby team change or rematch, a gated human
   * waits unspawned on the deploy screen (state 'dead', but no death, ticket,
   * kill-feed row or event) and spawns through the deploy intent exactly as
   * after a death, deploy timeout included. That timeout only runs once the
   * client sends its first input (it has loaded the map). Bots and
   * engine-level fixtures keep the immediate HQ spawn.
   */
  gateDeploy(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || entity.bot || !state) return false;
    state.deployGate = true;
    this._holdForDeploy(entity);
    return true;
  }

  /** Unspawn a gated human (a taken-over dead body stays dead) until a deploy; see gateDeploy. */
  _holdForDeploy(entity) {
    const state = this._state(entity);
    const wasAlive = entity.state === 'alive';
    entity.state = 'dead';
    // Off any seat it inherited (a taken-over bot); the hull carries on uncrewed.
    this.engine?.vehicles?.release?.(entity);
    entity.hp = 0;
    entity.spawnProtectedUntil = 0;
    entity.spawnProtected = false;
    if (wasAlive) {
      interruptMedkit(entity);
      Object.assign(entity, { armor: 0, burn: null, burning: 0, firing: false, ads: false, adsT: 0, reloading: false,
        reloadStage: null, charging: false, chargeT: 0, charge: 0, vx: 0, vy: 0, vz: 0, chute: 0, chuteT: 0 });
      // Stand by at the team's HQ: the welcome view and the spectator fallback anchor.
      const hq = this.hqPool(entity)[0];
      if (hq && [hq.x, hq.y, hq.z].every(Number.isFinite)) Object.assign(entity, { x: hq.x, y: hq.y, z: hq.z });
    }
    entity.respawnAt = Math.max(this.now, !wasAlive && Number.isFinite(entity.respawnAt) ? entity.respawnAt : this.now);
    state.deathHandled = true;
    state.deployHeld = true;
    this.deploy.onDeath(entity);
    this.bounds.clear(entity.id);
  }

  /** The deploy timeout of a held human waits for its client: until the first input, the clock stands still. */
  _holdDeployClock() {
    for (const [id, state] of this._players) {
      if (!state.deployHeld) continue;
      const entity = this._entities.get(id);
      if (entity?.state === 'dead' && entity.input == null && !(entity.respawnAt > this.now)) entity.respawnAt = this.now;
    }
  }

  /** Round start, rematch and lobby team changes spawn at HQ at once (a gated human waits on the deploy screen). */
  _respawn(entity, { emitEvent = true } = {}) {
    if (!entity.bot && this._state(entity)?.deployGate) { this._holdForDeploy(entity); return; }
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
    const issued = this.roles.applyLoadout(entity, kit, variant, gadget);
    // A Recon that comes back on another kit or gadget loses its beacon.
    if (issued) this.reconGadgets.onLoadout(entity, issued.kit, issued.gadget);
    // The FPV Engineer's drones for this life (any drone of the last one goes).
    fpvLoadout(this, entity, issued);
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

  /**
   * `{type:'deploy', spawn, kit, variant, gadget}` | `{type:'spot'}` | `{type:'support', support, targetId}` |
   * `{type:'redeploy'}` | `{type:'comm', comm}` (a comm rose pick) | `{type:'order', flag}` (a full-map order, '' clears) |
   * `{type:'mortar'}` (place the Support mortar) | `{type:'fpv'}` (launch or cut the Engineer's FPV drone).
   */
  conquestIntent(player, intent) {
    const entity = this._entity(player);
    if (!entity || !this._state(entity) || !intent || typeof intent !== 'object') return false;
    if (intent.type === 'deploy') return this._deployIntent(entity, intent);
    if (intent.type === 'redeploy') return this.redeploy(entity);
    if (intent.type === 'comm') return this.comms.intent(entity, intent.comm);
    if (intent.type === 'order') return this.phase === 'live' && this.squadOrders.issue(entity, intent.flag);
    // A map event's interaction point (`use`, contract v7) is held through the support plumbing.
    if (intent.type === 'support' && intent.support === MAP_EVENT_SUPPORT) return this.phase === 'live' && this.mapEvents.intent(entity, intent.targetId);
    if ((intent.type === 'spot' || intent.type === 'support') && this.phase === 'live') {
      return this.roles.intent(entity, intent) === true;
    }
    if (intent.type === 'mortar' && this.phase === 'live') return mortarIntent(this, entity);
    if (intent.type === 'crate' && this.phase === 'live') return this.supplyCrates.place(entity) !== null;
    if (intent.type === 'fpv' && this.phase === 'live') return fpvIntent(this, entity);
    return false;
  }

  /**
   * Deploy intent: a vehicle upgrade above the career level is refused like a
   * locked kit (`deploy_refused {reason:'locked', vehicle, upgrade, level}`);
   * an accepted deploy stores its `upgrades` for the hulls the player drives.
   */
  _deployIntent(entity, intent) {
    const locked = this.phase === 'live' && entity.state === 'dead' ? this.upgrades.refusal(entity, intent.upgrades) : null;
    if (locked) {
      this._emit('deploy_refused', { id: String(entity.id), reason: 'locked', vehicle: locked.type, upgrade: locked.id, level: locked.level });
      return false;
    }
    const accepted = this.deploy.intent(entity, intent);
    if (accepted) this.upgrades.choose(entity, intent.upgrades);
    return accepted;
  }

  /** An explosion (ProjectileSystem.explode): the Iron Bridge supports and the map events' integrity targets take their share. */
  onBlast(origin, blast) {
    if (this.phase !== 'live') return;
    // A map event's own scripted strike (the call-in) wears structures down under its cap.
    const structural = this.mapEvents.structureBlast(blast);
    this.bridge.onBlast(origin, structural);
    this.mapEvents.onBlast(origin, structural);
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
      beacons: this.reconGadgets.deployRows(),
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
      weather: this.weather.effects,
      bridge: this.bridge.view(),
      mapEvents: this.mapEvents.view(),
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
      conquest: this.conquestFields(entity), interaction: this.interactionOf(entity) };
  }

  /**
   * The row's `interaction` {kind, site, progress} while a hold runs (the
   * hold animations, shared/interact-anim.js): a map-event point (its verb
   * names the kind: plant, defuse, else hack), else a revive or a repair.
   */
  interactionOf(entity) {
    const point = this.mapEvents.instances?.length ? this.mapEvents.points.heldBy(entity.id) : null;
    if (point) return { kind: interactKindOfVerb(point.verb), site: null, progress: point.progress };
    return this.roles.actionInteraction?.(entity) ?? null;
  }

  /** `p.conquest`: {kit, squad, down, spotted, restrictedMs, actionProgress, stats, comm?}; snapshot.js encodes cq/cqs/cqc. */
  conquestFields(entity) {
    const id = String(entity.id);
    const fields = { kit: this.deploy.kitOf(id).kit, squad: this.squads.squadOf(id), down: false, spotted: false,
      restrictedMs: this.bounds.restrictedMs(id, this.now), actionProgress: 0 };
    const extra = this.roles.snapshotFields(entity);
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) if (value !== undefined && key !== 'stats') fields[key] = value;
    }
    // A map event hold (`use`) shows on the same action ring as a revive or repair.
    const held = this.mapEvents.progressOf(entity);
    if (held > (fields.actionProgress ?? 0)) fields.actionProgress = held;
    fields.stats = this.score.statsRow(id);
    // A live comm rose request rides the requester's row as `cqc`.
    if (this.phase === 'live') fields.comm = this.comms.fieldOf(id);
    // An FPV Engineer's drones left ride the row as `cqf` (shared/fpv-rules.js).
    fields.fpv = fpvField(this, entity);
    return fields;
  }

  /**
   * Per-player extras for the post-match results rows: cqs, squad, kit, plus
   * (contract v6) `cqr` ribbons, `cqm` medals, `cqp` score per category and,
   * for a human with a career, `cxp` [careerXp, xpGainedThisMatch]. The career
   * pair stays live after the freeze: the match and medal XP land post-match.
   */
  resultExtras(id) {
    const key = String(id);
    const career = this._careerExtras(key);
    if (this.phase === 'post' && this.finalStats.has(key)) return career ? { ...this.finalStats.get(key), ...career } : this.finalStats.get(key);
    if (!this._players.has(key)) return null;
    return { cqs: this.score.statsRow(key), squad: this.squads.squadOf(key), kit: this.deploy.kitOf(key).kit,
      cqr: this.ribbons.ribbonRow(key), cqm: this.ribbons.medalRow(key), cqp: this.score.categoryRow(key), ...career };
  }

  /**
   * One recipient's tick (server/lobby.js): the results rows' `cxp` (career XP
   * and this match's gain) is private, so only its owner's row keeps it. The
   * stripped tick is built once per tick and shared by every recipient
   * without a career row of their own; null (the tick itself) outside the
   * post phase or when no row carries `cxp`.
   */
  viewFor(recipientId, tick) {
    const results = tick?.match?.results;
    if (!Array.isArray(results) || !results.some(row => row?.cxp)) return null;
    if (this._viewTick !== tick) {
      this._viewTick = tick;
      this._viewStripped = { ...tick, match: { ...tick.match, results: results.map(row => {
        if (!row?.cxp) return row;
        const { cxp, ...rest } = row;
        return rest;
      }) } };
    }
    const stripped = this._viewStripped, self = String(recipientId);
    const own = results.findIndex(row => row?.cxp && String(row.id) === self);
    if (own < 0) return stripped;
    return { ...stripped, match: { ...stripped.match, results: stripped.match.results.map((row, i) => (i === own ? results[own] : row)) } };
  }

  _careerExtras(id) {
    const entity = this._entities.get(id);
    if (!entity || entity.bot || !Number.isFinite(entity.careerXp)) return null;
    return { cxp: [entity.careerXp, Number.isFinite(entity.careerMatchXp) ? entity.careerMatchXp : 0] };
  }

  matchSnapshot() {
    const ledger = this.ledger;
    const recon = this.phase === 'live' ? this.reconGadgets.snapshot() : null;
    const crates = this.phase === 'live' ? this.supplyCrates.snapshot() : null;
    const bridge = this.bridge.snapshot();
    const events = this.phase === 'live' ? this.mapEvents.snapshot() : null;
    const pouches = this.pouches.snapshot(this.now);
    return {
      ...super.matchSnapshot(),
      scores: { ...ledger.tickets },
      conquest: {
        v: 2,
        tickets: { ...ledger.tickets },
        maxTickets: ledger.max,
        // Breakthrough has no bleed: the field stays off its wire (clients read 0).
        ...(ledger.bleeds === false ? {} : { bleed: ledger.snapshotBleed() }),
        endsAt: Number.isFinite(ledger.endsAt) ? Math.round(ledger.endsAt) : null,
        flags: this.capture.flags.map(encodeConquestFlag),
        // A squad tuple gains its order flag as a 4th entry while it has one.
        squads: this.squads.tuples().map(tuple => {
          const flag = this.squadOrders.flagFor(tuple[0], tuple[1]);
          return flag ? [...tuple, flag] : tuple;
        }),
        ...(recon ? { recon } : {}),
        // Supply crates (contract v8, shared/supply-crates.js): rows while any stands.
        ...(crates ? { crates } : {}),
        ...(this.weather.tuple ? { wx: this.weather.snapshot() } : {}),
        ...(bridge ? { br: bridge } : {}),
        // Map events (contract v7): `ev` rows of the events that are not plain idle, `evp` the usable points.
        ...(events ?? {}),
        // Ammo pouches (contract v8): `[[id, x, y, z]]` on a tick where the set changed, plus a keyframe.
        ...(pouches ? { pch: pouches } : {}),
        ...(this.phase === 'post' ? { ticketGraph: ledger.graph.map(row => row.slice()) } : {}),
        ...this._conquestExtras(),
      },
    };
  }
}
