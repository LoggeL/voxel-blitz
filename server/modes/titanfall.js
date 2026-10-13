import { TEAM_IDS, titanfallScoreLimit } from '../../shared/modes.js';
import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TITAN_MV, TITANFALL_PLAYER_FLAGS, TITAN_LOADOUT_DEFAULT_PACKED, encodeTitanfallSelf, isTitanType,
  unpackTitanLoadout, encodeTitanfallPlayer, TITANFALL_DEPLOY_TIMEOUT_MS } from '../../shared/titan-contract.js';
import { createPilotState } from '../../shared/pilot-movement.js';
import { TdmPolicy } from './tdm.js';
import { weaponId } from './base-policy.js';
import { titanfallPlayArea, avoidSpawns, stepOutOfBounds, PLAY_AREA_RULES } from '../sim/titanfall/play-area.js';
import { applyTitanfallLoadout, titanfallOwned } from '../sim/titanfall/loadout.js';
import { meterStep, meterCredit } from '../sim/titanfall/meter.js';
import { usePilotTactical, stepPilotTacticals, pilotTacticalFlags, pilotTacticalStatus, resetPilotTactical } from '../sim/titanfall/pilot-tacticals.js';
import { releaseRider } from '../sim/titanfall/rodeo.js';
import { GruntSystem } from '../sim/titanfall/grunts.js';

const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
/** A loadout pick applies to the current life while it is this fresh (see _freshLife). */
const FRESH_LIFE = Object.freeze({ ms: 30000, radius: 2.5 });
/**
 * Deploy gate (docs/titanfall.md §3.4): a human spawns only once it sent `deploy`
 * (with its loadout); after `timeoutMs` past the respawn time the server deploys it
 * with the last selection, so an idle or stale tab still ends up on the field. The clock
 * stands still until the client's first input (still loading), as Conquest's gate does.
 */
export const DEPLOY_RULES = Object.freeze({ timeoutMs: TITANFALL_DEPLOY_TIMEOUT_MS });
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/**
 * Titanfall Attrition (docs/titanfall.md §1, §3). The frozen dispatcher (WP0):
 * TdmPolicy shape with attrition points, the titan meter, the play area and
 * the titanfall wire fields. Per-tick work and intents delegate to the
 * server/sim/titanfall modules and to VehicleSystem's TitanSystem
 * (`engine.vehicles.titans`). There is deliberately no `fallDamage` method:
 * pilots take no fall damage and ModeController.airborneRules() stays false.
 */
export class TitanfallPolicy extends TdmPolicy {
  constructor(context, engine = null) {
    super(context);
    this.mode = 'titanfall';
    this.engine = engine && typeof engine === 'object' ? engine : null;
    this.playArea = titanfallPlayArea(this.mapMeta, this.engine?.world);
    this.endsAt = this.now + this.rules.timeLimitMs;
    // Attrition minions (§10, WP8): engine.npcs bodies with their own tick hook.
    this.grunts = this.engine?.npcs ? new GruntSystem(this.engine, this) : null;
    // Result-row extras frozen at match end (reset() zeroes the live titan kills before a rematch).
    this.finalStats = new Map();
  }

  /** The TitanSystem of the engine's VehicleSystem (titanfall profile), or null. */
  get titans() { return this.engine?.vehicles?.titans ?? null; }

  /** Bot roam bounds {minX,maxX,minZ,maxZ} (server/bots.js `roamSpot`): the frontier rectangle; null on whole-map areas. */
  botBounds() { return this.playArea?.frontier ? this.playArea.bounds : null; }

  // --- per-player state ----------------------------------------------------

  /** Titanfall fields of a TDM state record, filled in on first use. */
  _tf(state) {
    if (!state) return null;
    if (!Number.isFinite(state.loadout)) state.loadout = TITAN_LOADOUT_DEFAULT_PACKED;
    if (!Number.isFinite(state.meter)) state.meter = 0;
    if (!Number.isFinite(state.titanKills)) state.titanKills = 0;
    if (!Number.isFinite(state.oobSince)) state.oobSince = 0;
    if (!Number.isFinite(state.oobUntil)) state.oobUntil = 0;
    if (typeof state.awaitDeploy !== 'boolean') { state.awaitDeploy = false; state.deployQueued = false; state.staged = false; }
    return state;
  }
  titanMeter(player) { return this._tf(this._state(player))?.meter ?? 0; }
  setTitanMeter(player, value) {
    const state = this._tf(this._state(player));
    if (state) state.meter = clamp01(value);
  }
  titanTypeFor(player) { return unpackTitanLoadout(this._tf(this._state(player))?.loadout ?? TITAN_LOADOUT_DEFAULT_PACKED).titan; }
  teamSpawnPool(team) {
    const own = this.playArea?.spawns?.[team];
    if (Array.isArray(own) && own.length) return own;
    const pool = this.mapMeta?.spawns?.tdm?.[team];
    return Array.isArray(pool) ? pool : [];
  }

  // --- scoring and match flow --------------------------------------------------

  /** Pilots (humans and bots) on the larger team. */
  _largestTeam() {
    const count = { [ALPHA]: 0, [BRAVO]: 0 };
    for (const state of this._players.values()) if (state.team in count) count[state.team]++;
    return Math.max(count[ALPHA], count[BRAVO]);
  }

  /**
   * The match's score limit, scaled to the larger team (titanfallScoreLimit). It only rises during a
   * match (a joiner raises it; a leaver never ends the match early) and holds after it; reset() rescales it.
   */
  scoreLimit({ fresh = false } = {}) {
    const limit = titanfallScoreLimit(this._largestTeam(), this.rules);
    if (fresh || !Number.isFinite(this._scoreLimit)) this._scoreLimit = limit;
    // After the match the limit stays as it was played (result screen).
    else if (this.phase === 'live') this._scoreLimit = Math.max(this._scoreLimit, limit);
    return this._scoreLimit;
  }

  _addScore(team, points) {
    if (this.phase !== 'live' || !(team === ALPHA || team === BRAVO) || !(points > 0)) return;
    const limit = this.scoreLimit();
    // Clamped at the limit: the last kill ends the match without an overshoot (300, not 304).
    this.scores[team] = Math.min(limit, this.scores[team] + points);
    this._emit('team_score', { team, score: this.scores[team] });
    if (this.scores[team] >= limit) this._finishMatch(team);
  }

  onPlayerDeath(victim, killer = null) {
    if (victim?.tfNpc) return this.grunts?.onDeath(victim, killer) === true;
    const dead = this._entity(victim);
    if (!dead) return false;
    const state = this._tf(this._state(dead));
    if (!state || state.deathHandled) return false;
    state.deathHandled = true;
    state.oobSince = 0;
    state.oobUntil = 0;
    dead.respawnAt = this.now + this.respawnDelay();
    if (this._deployGated(dead)) { state.awaitDeploy = true; state.deployQueued = false; state.staged = false; }
    const titans = this.titans;
    if (titans) {
      if (dead.rodeoVehicleId) releaseRider(titans, dead);
      if (dead.tfBattery) { dead.tfBattery = false; titans.bats.drop(dead.x, dead.y, dead.z, this.now); }
    }
    dead.embarkUntil = 0;
    if (this.phase === 'live' && killer && this.isEnemy(killer, dead)) {
      this._addScore(this.teamFor(killer), this.rules.points.pilot);
      meterCredit(this, this._entity(killer), 'pilotKill');
    }
    return true;
  }

  killScoreDelta(victim, killer) {
    if (victim?.tfNpc) return this.grunts?.scoreFor(victim, killer) ?? 0;
    return this.isEnemy(killer, victim) ? this.rules.points.pilot : 0;
  }

  /** VehicleSystem events: a destroyed titan is worth `points.titan` to the destroyer's team. */
  onVehicleEvent(kind, payload) {
    if (kind !== 'vehicle_destroyed' || !isTitanType(payload?.vehicleType ?? payload?.type)) return;
    const attacker = payload.attacker == null ? null : this._entity(String(payload.attacker));
    const team = attacker ? this.teamFor(attacker) : null;
    if (!attacker || !team || team === payload.team || this.phase !== 'live') return;
    attacker.score = (attacker.score || 0) + this.rules.points.titan;
    const state = this._tf(this._state(attacker));
    if (state) state.titanKills++;
    meterCredit(this, attacker, 'titanKill');
    this._addScore(team, this.rules.points.titan);
  }

  /** Per-tick upkeep before the simulation: passive meter, tacticals, OOB. */
  beforeTick(dt) {
    if (this.phase !== 'live' || !(dt > 0)) return;
    const now = this.now;
    for (const entity of this._entities.values()) {
      const state = this._tf(this._state(entity));
      // Deploy gate: a staged human (join, match start, takeover) that never sent input (still loading)
      // keeps its idle-deploy clock at zero, as Conquest's gate does.
      if (state?.staged && state.awaitDeploy && entity.state === 'dead' && entity.input == null && this._deployGated(entity)
        && !(entity.respawnAt > now)) entity.respawnAt = now;
      if (!state || entity.state !== 'alive') continue;
      meterStep(this, entity, dt);
      this._outOfBounds(entity, state, now);
    }
    stepPilotTacticals(this, this._entities, now, dt);
  }

  _outOfBounds(entity, state, now) {
    const hull = entity.vehicleId ? this.engine?.vehicles?.vehicles.get(entity.vehicleId) : null;
    const at = hull ?? entity;
    const result = stepOutOfBounds(this.playArea, at.x, at.y, at.z, state, now);
    state.oobUntil = result.warn ? result.until : 0;
    if (result.started) this._emit('oob_warning', { id: String(entity.id), until: result.until });
    if (!result.kill) return;
    state.oobSince = 0;
    state.oobUntil = 0;
    if (typeof entity.takeDamage === 'function') {
      entity.takeDamage(Math.max(1, (Number.isFinite(entity.hp) ? entity.hp : 100) + Math.max(0, entity.armor || 0)), false, null, 'restricted');
    }
    this.engine?.killPlayer?.(entity, null, 'restricted', false);
  }

  tick() {
    super.tick();
    if (this.phase !== 'live' || !(this.now >= this.endsAt)) return;
    const a = this.scores[ALPHA], b = this.scores[BRAVO];
    this._finishMatch(a > b ? ALPHA : b > a ? BRAVO : null);
  }

  /** Freeze every player's result extras (titan kills, loadout) before the post phase. */
  _finishMatch(winner) {
    if (this.phase === 'live') this.finalStats = new Map([...this._players.keys()].map(id => [String(id), this.resultExtras(id)]));
    return super._finishMatch(winner);
  }

  /**
   * Per-player extras for the post-match results rows: the `tf` row the result
   * scoreboard reads (TITANS = tf[7]), frozen at match end.
   */
  resultExtras(id) {
    const key = String(id);
    if (this.phase === 'post' && this.finalStats?.has(key)) return this.finalStats.get(key);
    const state = this._players.get(key);
    if (!state) return null;
    this._tf(state);
    return { tf: encodeTitanfallPlayer({ mv: TITAN_MV.ground, titanId: null, loadout: state.loadout, flags: 0, meter: 0,
      rodeoVehicleId: null, grapple: null, titanKills: state.titanKills }) };
  }

  reset() {
    this.finalStats = new Map();
    this.playArea = titanfallPlayArea(this.mapMeta, this.engine?.world);
    this.titans?.reset();
    this.grunts?.reset();
    for (const state of this._players.values()) {
      this._tf(state);
      state.meter = 0;
      state.titanKills = 0;
      state.oobSince = 0;
      state.oobUntil = 0;
    }
    this.endsAt = this.now + this.rules.timeLimitMs;
    super.reset();
    this.scoreLimit({ fresh: true });
  }

  // --- gates ---------------------------------------------------------------------

  canMove(player) {
    const entity = this._entity(player);
    return !(entity?.embarkUntil > this.now);
  }

  canFire(player) {
    const entity = this._entity(player);
    return super.canFire(entity) && !(entity.embarkUntil > this.now);
  }

  /** Only the owned loadout ([primary, revolver, at, knife]). */
  canUseWeapon(player, weapon) {
    const id = weaponId(weapon);
    if (!id) return false;
    const owned = this._entity(player)?.owned;
    return Array.isArray(owned) ? owned.includes(id) : super.canUseWeapon(player, weapon);
  }

  // --- deploy gate (§3.4) -------------------------------------------------------------

  /** Humans spawn only on DEPLOY (or the timeout); bots keep the plain timed respawn. */
  _deployGated(entity) { return !!entity && !entity.bot; }

  /**
   * Hold a player off the field until it deploys (join, match start, rematch, team change,
   * bot takeover). Not a death: no event, no score, no death count. Its titan stays where it is
   * (an occupied one is left like on a death).
   */
  _stage(entity, state) {
    if (!entity || !state) return;
    const titans = this.titans;
    if (entity.state === 'alive') {
      this.engine?.vehicles?.release?.(entity);
      if (titans && entity.rodeoVehicleId) releaseRider(titans, entity);
      if (titans && entity.tfBattery) titans.bats.drop(entity.x, entity.y, entity.z, this.now);
    }
    entity.tfBattery = false;
    entity.rodeoVehicleId = null;
    entity.embarkUntil = 0;
    entity.hp = 0;
    entity.state = 'dead';
    entity.respawnAt = this.now;
    entity.firing = false;
    entity.ads = false;
    entity.adsT = 0;
    entity.reloading = false;
    entity.vx = 0; entity.vy = 0; entity.vz = 0;
    entity.spawnProtectedUntil = 0;
    entity.spawnProtected = false;
    state.deathHandled = true;
    state.oobSince = 0;
    state.oobUntil = 0;
    state.awaitDeploy = true;
    state.deployQueued = false;
    state.staged = true;
  }

  _clearDeploy(state) {
    if (!state) return;
    state.awaitDeploy = false;
    state.deployQueued = false;
    state.staged = false;
  }

  /** The respawn timer has run out and a human sent DEPLOY (or waited past DEPLOY_RULES.timeoutMs). */
  canTimedRespawn(player) {
    const entity = this._entity(player);
    if (!super.canTimedRespawn(entity)) return false;
    const state = this._state(entity);
    if (!this._deployGated(entity) || !state?.awaitDeploy || state.deployQueued) return true;
    const timeout = Number.isFinite(this.rules.deployTimeoutMs) ? this.rules.deployTimeoutMs : DEPLOY_RULES.timeoutMs;
    return this.now >= (Number.isFinite(entity.respawnAt) ? entity.respawnAt : this.now) + timeout;
  }

  onPlayerRespawn(player) {
    const respawned = super.onPlayerRespawn(player);
    this._clearDeploy(this._state(player));
    return respawned;
  }

  /**
   * Node suites and tools: put a held human on the field at once, exactly like the plain TDM
   * join spawn (no spawn protection, no respawn event) with its current selection.
   */
  deployNow(player) {
    const entity = this._entity(player);
    const state = this._tf(this._state(entity));
    if (!entity || !state || entity.state === 'alive') return false;
    super._respawn(entity, { emitEvent: false });
    this._clearDeploy(state);
    return entity.state === 'alive';
  }

  /** TDM's immediate spawn for bots; a human is held for DEPLOY instead. */
  _respawn(entity, options = {}) {
    const state = this._tf(this._state(entity));
    if (state && this._deployGated(entity)) { this._stage(entity, state); return; }
    super._respawn(entity, options);
    this._clearDeploy(state);
  }

  // --- spawns and loadout ------------------------------------------------------------

  spawnPoolFor(player) { return this.teamSpawnPool(this.teamFor(player)); }

  /** Skips points within spawnAvoid of an enemy titan or a pending drop. */
  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    const pool = this.spawnPoolFor(entity), team = this.teamFor(entity), hazards = [];
    for (const v of this.titans?.titans() ?? []) {
      if ((v.hp > 0 || v.dropping) && v.team !== team) hazards.push(v);
    }
    return this._chooseSpawn(avoidSpawns(pool, hazards, PLAY_AREA_RULES.spawnAvoid), entity, excludeIndex);
  }

  applyRespawnLoadout(player, { keepLife = false } = {}) {
    const entity = this._entity(player);
    const state = this._tf(this._state(entity));
    if (!entity || !state) return false;
    if (!keepLife || !entity.tfLife) entity.tfLife = { at: this.now, x: entity.x, z: entity.z, shotSeq: entity.shotSeq };
    const kit = applyTitanfallLoadout(entity, state.loadout);
    const tac = resetPilotTactical(entity, kit.tactical);
    // What this life was issued: a thrown grenade or a used tactical ends the fresh life (_freshLife).
    entity.tfLife.grenades = Array.isArray(entity.grenades) ? [...entity.grenades] : [];
    entity.tfLife.tacCharges = tac?.charges ?? 0;
    entity.pilot = createPilotState();
    entity.tfBattery = false;
    entity.rodeoVehicleId = null;
    entity.embarkUntil = 0;
    this._syncPlayer(entity, state);
    return true;
  }

  /**
   * True while a life may still swap its kit (§3.7 `loadout`): alive on foot, within
   * FRESH_LIFE.radius of its spawn spot and FRESH_LIFE.ms of the spawn, no shot fired, full health.
   */
  _freshLife(entity) {
    const life = entity?.tfLife;
    return !!life && entity.state === 'alive' && !entity.vehicleId && !entity.rodeoVehicleId && !(entity.embarkUntil > this.now)
      && this.now - life.at <= FRESH_LIFE.ms && entity.shotSeq === life.shotSeq && !(entity.hp < (entity.maxHp ?? 100))
      && Math.hypot(entity.x - life.x, entity.z - life.z) <= FRESH_LIFE.radius && this._kitUntouched(entity, life);
  }

  /** No grenade thrown and no tactical used since the kit was issued (a re-pick never refills them). */
  _kitUntouched(entity, life) {
    const issued = Array.isArray(life.grenades) ? life.grenades : [];
    const now = Array.isArray(entity.grenades) ? entity.grenades : [];
    if (issued.some((count, i) => !((now[i] ?? 0) >= count))) return false;
    const tac = entity.pilotTac;
    return !tac || (!(tac.readyAt > 0) && !(tac.cloakUntil > 0) && !(tac.stimUntil > 0) && !((tac.charges ?? 0) < (life.tacCharges ?? 0)));
  }

  /** TDM's sync without the free arsenal: the owned loadout stays. */
  _syncPlayer(entity, state) {
    entity.team = state.team;
    entity.credits = 0;
    if (!Array.isArray(entity.owned) || !entity.owned.every(id => WEAPON_IDS.includes(id))) {
      entity.owned = titanfallOwned(this._tf(state).loadout);
    }
    entity.bomb = false;
    entity.interaction = null;
    entity.spawnProtected = this._spawnProtected(entity);
  }

  // --- lifecycle hooks -----------------------------------------------------------------

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    this.titans?.removeOwned(id, 'leave');
    return super.onPlayerRemove(player);
  }

  setLobbyTeam(player, team) {
    const entity = this._entity(player);
    const state = this._tf(this._state(entity));
    if (state && state.team !== team && TEAM_IDS.includes(team)) {
      this.titans?.removeOwned(String(entity.id), 'team');
      state.meter = 0;
    }
    return super.setLobbyTeam(player, team);
  }

  onPlayerTakeover(player, nextId) {
    const entity = this._entity(player);
    const priorId = entity ? String(entity.id) : '';
    const moved = super.onPlayerTakeover(player, nextId);
    if (moved) this.titans?.renameOwner(priorId, String(nextId));
    // The joining human starts on the loadout screen too: an alive bot body leaves the field
    // (its titan stays), a dead one keeps its respawn time but now waits for DEPLOY.
    const state = moved ? this._tf(this._players.get(String(nextId))) : null;
    if (state && entity) {
      if (entity.state === 'alive') this._stage(entity, state);
      else { state.awaitDeploy = true; state.deployQueued = false; state.staged = true; }
    }
    return moved;
  }

  // --- intents -------------------------------------------------------------------------

  /** `{t:'titanfall'}` intent parsed by parseTitanfallIntent: {type, value}. */
  titanfallIntent(player, intent) {
    const entity = this._entity(player);
    const state = this._tf(this._state(entity));
    if (!entity || !state || !intent || typeof intent.type !== 'string') return false;
    const titans = this.titans, value = intent.value;
    switch (intent.type) {
      case 'loadout':
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) return false;
        state.loadout = value;
        // The pick made before start or stored on the device reaches the server after the first
        // spawn: a fresh life (still on its spawn spot, nothing fired, unhurt) takes it at once.
        if (this._freshLife(entity)) this.applyRespawnLoadout(entity, { keepLife: true });
        return true;
      case 'deploy':
        // DEPLOY on the loadout screen: the pick plus the spawn request. Dead, it queues the spawn
        // (processRespawns takes it once the respawn timer has run out); alive it is a plain pick.
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) return false;
        state.loadout = value;
        if (entity.state === 'alive') {
          if (this._freshLife(entity)) this.applyRespawnLoadout(entity, { keepLife: true });
          return true;
        }
        state.deployQueued = true;
        return true;
      case 'call':
        return this.phase === 'live' && !!titans && titans.call(entity, value).ok === true;
      case 'ability': {
        const v = titans && entity.vehicleId ? this.engine.vehicles.vehicles.get(entity.vehicleId) : null;
        return this.phase === 'live' && !!v && titans.ability(v, entity, value) === true;
      }
      case 'eject': {
        const v = titans && entity.vehicleId ? this.engine.vehicles.vehicles.get(entity.vehicleId) : null;
        return !!v && titans.eject(v, entity) === true;
      }
      case 'tac':
        return this.phase === 'live' && entity.state === 'alive' && usePilotTactical(this, entity, this.now) === true;
      case 'rodeo':
        return this.phase === 'live' && !!titans && titans.rodeo(entity, value) === true;
      default:
        return false;
    }
  }

  // --- snapshots -----------------------------------------------------------------------

  /** `p.titanfall`: the record snapshot.js encodes as the `tf` row (§3.1). */
  titanfallFields(entity, state) {
    const now = this.now, titan = this.titans?.ownedBy(entity.id) ?? null, F = TITANFALL_PLAYER_FLAGS;
    let flags = pilotTacticalFlags(entity, now);
    if (entity.tfBattery) flags |= F.battery;
    if (entity.ejectCloakUntil > now) flags |= F.ejectCloak;
    if (state.oobUntil > now) flags |= F.oob;
    if (entity.state !== 'alive' && state.awaitDeploy) {
      flags |= F.deploy;
      if (state.deployQueued) flags |= F.deployQueued;
      if (state.staged) flags |= F.staged;
    }
    const mv = entity.embarkUntil > now ? TITAN_MV.embarking
      : entity.vehicleId && titan?.id === entity.vehicleId ? TITAN_MV.piloting
        : entity.rodeoVehicleId ? TITAN_MV.rodeo
          : entity.pilot?.grapple ? TITAN_MV.grapple
            : entity.pilot?.wall ? TITAN_MV.wallrun
              : entity.pilot?.slideT > 0 && entity.grounded !== false ? TITAN_MV.slide
                : entity.grounded === false ? TITAN_MV.air : entity.sprint ? TITAN_MV.sprint : TITAN_MV.ground;
    return { mv, titanId: titan?.id ?? null, loadout: state.loadout, flags, meter: state.meter,
      rodeoVehicleId: entity.rodeoVehicleId ?? null, grapple: entity.pilot?.grapple?.anchor ?? null, titanKills: state.titanKills };
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    const base = super.playerSnapshot(player);
    const state = this._tf(this._state(entity));
    if (!entity || !state) return base;
    return { ...base, owned: Array.isArray(entity.owned) ? entity.owned.slice() : titanfallOwned(state.loadout),
      titanfall: this.titanfallFields(entity, state) };
  }

  /** The self-only `tfs` frame for one member after a tick (lobby sends it), or null. */
  selfFrame(memberId, tick) {
    const entity = this._entity(String(memberId ?? ''));
    const state = this._state(entity);
    if (!entity || !state) return null;
    const pilot = entity.pilot ?? {};
    const tac = pilotTacticalStatus(entity, this.now);
    return { t: 'tfs', s: Number.isFinite(tick?.now) ? tick.now : this.now, d: encodeTitanfallSelf({
      vx: entity.vx, vy: entity.vy, vz: entity.vz, wallN: pilot.wall, wallT: pilot.wallT, jumpsLeft: pilot.jumpsLeft,
      slideT: pilot.slideT, slideCd: pilot.slideCd, tacCharges: tac.tacCharges, tacReady: tac.tacReady,
      jumpSeqAck: pilot.jumpSeqAck, lockProgress: entity.lockProgress ?? 0, tacKind: entity.pilotTac?.kind }) };
  }

  matchSnapshot() {
    const titans = this.titans;
    const count = team => titans?.teamTitans(team) ?? 0;
    const cap = titans ? Math.max(titans.bayCap(ALPHA), titans.bayCap(BRAVO)) : 0;
    return { ...super.matchSnapshot(), titanfall: { v: 1, endsAt: this.endsAt, scoreLimit: this.scoreLimit(),
      sc: [this.scores[ALPHA], this.scores[BRAVO]], bat: titans?.batteries() ?? [], bay: [count(ALPHA), count(BRAVO), cap], npc: this.grunts?.wire() ?? [] } };
  }
}
