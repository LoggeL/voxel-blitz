import { BREAKTHROUGH_RULES, CONQUEST_TEAMS } from '../../../shared/conquest-contract.js';
import { buildCapturePresence, flagPresence, oppositeTeam, teamSign } from '../../../shared/conquest.js';
import {
  boatLanePoints, breakthroughAxis, breakthroughFront, breakthroughHeldPads, breakthroughHqAnchor, breakthroughHqFlags, breakthroughSectors,
  breakthroughVehicleSpawns, encodeBreakthrough, outsideFront, sectorRole,
} from '../../../shared/breakthrough.js';
import { ConquestPolicy } from '../conquest.js';
import { TicketLedger } from './tickets.js';
import { BoundsSystem } from './bounds.js';

/**
 * Ticket accounting of Breakthrough: only the attackers have tickets (deaths
 * cost them, revives refund them, a captured sector refills them up to the
 * starting pool). The defenders never lose by tickets and win the time limit.
 * No bleed. The graph keeps both columns, the defenders' at 0.
 */
export class BreakthroughLedger extends TicketLedger {
  get attackers() { return this.rules.attackers ?? 'alpha'; }
  /** No ticket bleed: match.conquest leaves `bleed` out. */
  get bleeds() { return false; }

  reset(nowMs) {
    super.reset(nowMs);
    for (const team of CONQUEST_TEAMS) if (team !== this.attackers) this.tickets[team] = 0;
    this.graph = [[0, this.tickets.alpha, this.tickets.bravo]];
  }

  charge(team, count = 1) { return team === this.attackers ? super.charge(team, count) : []; }
  refund(team, count = 1) { return team === this.attackers ? super.refund(team, count) : false; }

  /**
   * A captured sector's refill: `count` tickets back, capped at the pool.
   * Re-arms the ticket-low calls the attackers climbed back above. Returns the
   * tickets actually added.
   */
  refill(count) {
    const team = this.attackers, before = this.tickets[team];
    this.tickets[team] = Math.min(this.max, before + Math.max(0, Math.trunc(count) || 0));
    for (const fraction of this.rules.ticketLowFractions || []) {
      if (this.tickets[team] > Math.floor(this.max * fraction)) this.lowFired[team].delete(fraction);
    }
    return this.tickets[team] - before;
  }

  /** No bleed; `zero` is the attackers once their pool is empty. */
  step(nowMs, dtMs, held) {
    const { low } = super.step(nowMs, dtMs, held);
    return { low, zero: this.tickets[this.attackers] <= 0 ? this.attackers : null };
  }

  /** The time limit always goes to the defenders: they held the line. */
  timeLimitWinner() { return oppositeTeam(this.attackers); }
}

/**
 * HQ restriction and combat area plus the Breakthrough front: a defender
 * behind the lost sector's line (once its fall-back grace ran out) or an
 * attacker past the line ahead of the active sector runs the out-of-bounds
 * timer (`front`). Aircraft crew keep the airspace rules only.
 */
export class FrontBounds extends BoundsSystem {
  reset(metaConquest, options) {
    super.reset(metaConquest, options);
    this.front = this.front ?? null;
    this.frontAttackers = this.frontAttackers ?? 'alpha';
    this.graceUntil = this.graceUntil ?? 0;
    this.stepNow = 0;
  }

  setFront(front, { attackers, graceUntil = 0 } = {}) {
    this.front = front ?? null;
    this.frontAttackers = attackers ?? this.frontAttackers;
    this.graceUntil = Number.isFinite(graceUntil) ? graceUntil : 0;
  }

  violation(p, team, aircraft = false) {
    const zone = super.violation(p, team, aircraft);
    if (zone || aircraft || !this.front) return zone;
    return outsideFront(this.front, p, team, this.frontAttackers, { rear: this.stepNow >= this.graceUntil }) ? 'front' : null;
  }

  step(now, entities, hooks) {
    this.stepNow = now;
    return super.step(now, entities, hooks);
  }
}

/**
 * Breakthrough (docs/conquest.md, Breakthrough): Conquest's flags, kits,
 * vehicles, deploy, squads and bots on an ordered line of sectors. Every flag
 * starts with the defenders; only the active sector's flags can change hands
 * (CaptureSystem.locked). Holding all of them advances the front: the sector
 * locks for the attackers, their tickets refill, the defenders get
 * `fallbackGraceMs` before the ground behind the new line is out of bounds
 * for them, and the attackers' forward spawns move up. The attackers win by
 * taking the last sector; the defenders when the attackers run out of
 * tickets (after an overtime while attackers still take or contest an active
 * flag) or at the time limit.
 */
export class BreakthroughPolicy extends ConquestPolicy {
  constructor(context, engine = null) {
    super({ ...context, rules: { ...context.rules, ...BREAKTHROUGH_RULES } }, engine);
  }

  get variant() { return 'breakthrough'; }
  get attackerTeam() { return this.rules.attackers; }
  get defenderTeam() { return oppositeTeam(this.rules.attackers); }

  _createLedger() { return new BreakthroughLedger(this.rules); }
  _createBounds() { return new FrontBounds(this.rules); }

  /**
   * The Breakthrough hull list (breakthroughVehicleSpawns). Every reset is a
   * round start, so the 'lane' pads held in the first sector start empty
   * (`held`); _syncLanePads moves them with the front.
   */
  vehicleSpawns() {
    const list = breakthroughVehicleSpawns(super.vehicleSpawns(), this.rules);
    const held = this.sectors ? this._heldPads(list, { ...this.btView(), sector: 0, done: false }) : new Set();
    return held.size ? list.map(s => (held.has(s.id) ? { ...s, held: true } : s)) : list;
  }

  /** Pads held at the sector of `bt`: 'lane' hulls whose side of the front keeps none of the boat lane. */
  _heldPads(list, bt) {
    const front = breakthroughFront(bt, this.capture.flags, this.mapMeta?.conquest?.bases, this.rules);
    return breakthroughHeldPads(list, { bt, front, lanes: boatLanePoints(this.mapMeta?.conquest?.waterways), rules: this.rules });
  }

  /**
   * Hold or release the 'lane' pads for the active sector (BREAKTHROUGH_RULES.vehicles.types):
   * on Frontier the attackers' patrol boats launch with the Iron Bridge sector, the defenders'
   * stand down once it falls (a crewed boat sails on until it is lost).
   */
  _syncLanePads() {
    const vehicles = this.vehicleSystem;
    if (typeof vehicles?.setPadHeld !== 'function' || !this.bt) return;
    const list = breakthroughVehicleSpawns(super.vehicleSpawns(), this.rules);
    const held = this._heldPads(list, this.btView());
    for (const s of list) if (this.rules.vehicles?.types?.[s.type] === 'lane' && typeof s.flag !== 'string') vehicles.setPadHeld(s.id, held.has(s.id));
  }

  /** Called by the base constructor too, so it only reads rules and map data. */
  _resetObjectives() {
    super._resetObjectives();
    const defenders = this.defenderTeam;
    this.sectors = this._sectorTable();
    this.bt = { sector: 0, graceEndsAt: 0, overtime: false, takenAt: [] };
    for (const flag of this.capture.flags) {
      Object.assign(flag, { owner: defenders, control: teamSign(defenders), state: 'idle', mover: null, home: defenders });
    }
    this.capture.locked = flag => sectorRole(this.btView(), flag.id) !== 'active';
    this._syncPads();
    this._updateFront();
    this._syncLanePads();
  }

  /** The map's sector table restricted to its flags; without one, a sector per flag along the HQ axis. */
  _sectorTable() {
    const ids = new Set(this.capture.flags.map(f => f.id));
    const table = (breakthroughSectors(this.mapMeta?.id, this.rules) ?? [])
      .map(sector => sector.filter(id => ids.has(id))).filter(sector => sector.length);
    if (table.length) return table;
    const axis = breakthroughAxis(this.mapMeta?.conquest?.bases, this.attackerTeam);
    return this.capture.flags.slice().sort((a, b) => (axis ? axis.project(a) - axis.project(b) : 0)).map(f => [f.id]);
  }

  /** decodeBreakthrough-shaped view of the authoritative state. */
  btView() {
    const sectors = this.sectors ?? [];
    return { attackers: this.attackerTeam, defenders: this.defenderTeam, sector: this.bt?.sector ?? 0, sectors, count: sectors.length,
      graceEndsAt: this.bt?.graceEndsAt || null, overtime: this.bt?.overtime === true, done: (this.bt?.sector ?? 0) >= sectors.length };
  }

  _updateFront() {
    this.front = breakthroughFront(this.btView(), this.capture.flags, this.mapMeta?.conquest?.bases, this.rules);
    this.bounds.setFront?.(this.front, { attackers: this.attackerTeam, graceUntil: this.bt.graceEndsAt });
  }

  /** Flags of the active sector (none once broken through). */
  activeFlags() {
    const ids = this.sectors[this.bt.sector] ?? [];
    return ids.map(id => this.capture.flag(id)).filter(Boolean);
  }

  _afterCapture(now) {
    const active = this.activeFlags();
    if (active.length && active.every(f => f.owner === this.attackerTeam)) { this._advanceSector(now, active); return; }
    // A revive refund put tickets back in the pool: the overtime is over, the round runs on as usual.
    if (this.bt.overtime && this.ledger.tickets[this.attackerTeam] > 0) { this.bt.overtime = false; return; }
    // Overtime lasts while attackers still take or contest an active flag.
    if (this.bt.overtime && !this._attackersPushing()) this._finishMatch(this.defenderTeam);
  }

  _advanceSector(now, flags) {
    const taken = this.bt.sector;
    // The taken flags lock at full attacker control.
    for (const flag of flags) {
      const busy = flag.state !== 'idle';
      Object.assign(flag, { control: teamSign(this.attackerTeam), state: 'idle', mover: null });
      if (busy) this._emit('flag_state', { flag: flag.id, state: 'idle', team: null });
    }
    this.bt.sector = taken + 1;
    this.bt.takenAt.push(Math.max(0, Math.round(now - this.ledger.startedAt)));
    const done = this.bt.sector >= this.sectors.length;
    const refill = done ? 0 : this.ledger.refill(this.rules.refillPerSector);
    this.bt.graceEndsAt = done ? 0 : now + this.rules.fallbackGraceMs;
    if (refill > 0) this.bt.overtime = false;
    this._updateFront();
    this._syncLanePads();
    this._emit('sector_captured', { sector: taken, next: done ? -1 : this.bt.sector, team: this.attackerTeam, flags: flags.map(f => f.id),
      refill, tickets: this.ledger.tickets[this.attackerTeam], graceEndsAt: this.bt.graceEndsAt || null });
    if (done) this._finishMatch(this.attackerTeam);
  }

  /**
   * Living attackers inside an active flag that is not securely theirs. The
   * presence is counted now, not read from the flag rows (the last capture
   * step): the last ticket can go with the death of the only pusher, who must
   * not start an overtime.
   */
  _attackersPushing() {
    const attackers = this.attackerTeam, defenders = this.defenderTeam;
    const presence = buildCapturePresence(this._entities.values(), {
      teamFor: p => this.teamFor(p),
      vehicleFor: id => this.vehicleFor(id),
      isDown: p => this.roles.isDown(p) === true,
    });
    return this.activeFlags().some(f => flagPresence(f, presence, this.rules)[attackers] > 0
      && (f.owner !== attackers || f.state === 'contested' || f.mover === defenders));
  }

  _onTicketsOut(team) {
    if (team !== this.attackerTeam || this.phase !== 'live') return;
    if (this.rules.overtime && this._attackersPushing()) {
      if (!this.bt.overtime) { this.bt.overtime = true; this._emit('sector_overtime', { team }); }
      return;
    }
    this._finishMatch(this.defenderTeam);
  }

  /**
   * The HQ moves with the front (breakthroughHqFlags): the spawn cells of the
   * attackers' last taken sector, or of the sector behind the defenders' active
   * one; the real HQ otherwise. Round starts, the deploy HQ entry and the
   * deploy timeout all spawn here.
   */
  hqPool(player) {
    const team = this.teamFor(player), bt = this.bt && this.sectors ? this.btView() : null;
    // Round start (and joins, rematches, team changes): the defenders stand dug in on the
    // active sector's flags they still hold, one flag per squad, so both flags of a two-flag
    // sector are manned. A flag the attackers took mid-round is no defender spawn.
    const active = bt && !bt.done ? bt.sectors[bt.sector].filter(id => this.capture.flag(id)?.owner === this.defenderTeam) : [];
    const squad = Math.max(1, this.squads.squadOf(this._entity(player)?.id) | 0);
    const ids = !bt ? null : this._startSpawn && team === this.defenderTeam && active.length ? [active[(squad - 1) % active.length]]
      : breakthroughHqFlags(bt, team);
    const cells = ids ? ids.flatMap(id => this.capture.flag(id)?.spawns ?? []) : [];
    return cells.length ? cells : super.hqPool(player);
  }

  /** Spawns without a deploy (round start, rematch, joins, team changes): see hqPool. */
  _respawn(entity, options) {
    this._startSpawn = true;
    try { super._respawn(entity, options); } finally { this._startSpawn = false; }
  }

  /** Attackers out of tickets stay on the deploy screen. */
  canTimedRespawn(player) {
    const entity = this._entity(player);
    if (entity && this.teamFor(entity) === this.attackerTeam && !(this.ledger.tickets[this.attackerTeam] > 0)) return false;
    return super.canTimedRespawn(player);
  }

  deployView() {
    return { ...super.deployView(), breakthrough: { ...this.btView(), tickets: this.ledger.tickets[this.attackerTeam] } };
  }

  /** The bot view adds the sector state, the front and each flag's sector role. */
  conquestView() {
    const value = super.conquestView();
    if (!value.breakthrough) {
      value.breakthrough = this.btView();
      value.front = this.front;
      value.hqAnchors = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, breakthroughHqAnchor(value.breakthrough, team, this.capture.flags)]));
      for (const flag of value.flags) flag.role = sectorRole(value.breakthrough, flag.id);
    }
    return value;
  }

  _conquestExtras() {
    return { bt: encodeBreakthrough({ attackers: this.attackerTeam, sector: this.bt.sector, sectors: this.sectors,
      graceEndsAt: this.bt.graceEndsAt > this.now ? this.bt.graceEndsAt : 0, overtime: this.bt.overtime }) };
  }

  _matchEndExtras() {
    return { variant: 'breakthrough', attackers: this.attackerTeam, sector: this.bt.sector, sectors: this.sectors.length };
  }
}
