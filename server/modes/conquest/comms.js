import { COMM_KINDS, COMM_RADIO, COMM_RULES, encodeCommField, flagInSight } from '../../../shared/conquest-comms.js';
import { vehicleMaxHp } from '../../../shared/vehicles.js';

const EYE_HEIGHT = 1.6;
const idOf = value => (value && typeof value === 'object' ? String(value.id) : String(value ?? ''));

/**
 * The comm rose on the server (docs/conquest.md "Squad orders and the comm
 * rose"). One `comm` intent per pick:
 *  - requests (NEED MEDIC / AMMO / REPAIR / RIDE) open a short-lived marker,
 *    one per player, that rides `match.conquest.comms` until it is served or
 *    times out (COMM_RULES.requestMs); the bot commander sends a bot of the
 *    matching role and names it with `answer` (`comm_answer`);
 *  - AFFIRMATIVE / NEGATIVE are radio callouts (`comm` event, no marker);
 *  - SPOT spots along the view (the ordinary spot intent);
 *  - ORDER orders the squad onto the flag under the crosshair (leaders only).
 *
 * `policy` is the ConquestPolicy: now, teamFor, _entity, _emit, phase,
 * squads, orders, roles (isDown, kitOf, refilledAt, intent) and the engine's
 * VehicleSystem.
 */
export class CommSystem {
  constructor(policy, rules = COMM_RULES) {
    this.policy = policy;
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.requests = new Map(); // requester id -> request
    this.lastAt = new Map();   // player id -> last accepted comm
    this.acks = [];            // pending bot AFFIRMATIVEs after a human leader's order
  }

  get vehicles() { return this.policy.engine?.vehicles?.vehicles ?? null; }

  /** One comm rose pick; true when accepted. */
  intent(player, kind) {
    const p = this.policy._entity(player);
    if (!p || this.policy.phase !== 'live' || !COMM_KINDS.includes(kind)) return false;
    const id = idOf(p), now = this.policy.now;
    const down = this.policy.roles?.isDown?.(p) === true;
    // A downed body may still call a medic; everything else needs a living player.
    if (p.state !== 'alive' && !(down && kind === 'medic')) return false;
    if (now - (this.lastAt.get(id) ?? -Infinity) < this.rules.cooldownMs) return false;
    let ok = false;
    if (kind === 'spot') ok = this.policy.roles?.intent?.(p, { type: 'spot' }) === true;
    else if (kind === 'order') ok = this.orderInSight(p);
    else if (COMM_RADIO.includes(kind)) { this.radio(p, kind); ok = true; }
    else ok = this.request(p, kind, now);
    if (ok) this.lastAt.set(id, now);
    return ok;
  }

  /** ORDER from the rose: the flag under the crosshair (shared flagInSight, the client labels the rose with it). */
  orderInSight(p) {
    const eye = { x: p.x, y: (Number.isFinite(p.eyeY) ? p.eyeY : p.y + EYE_HEIGHT), z: p.z };
    const flag = flagInSight(eye, p.yaw, p.pitch, this.policy.capture.flags, this.rules);
    return !!flag && this.policy.squadOrders.issue(p, flag.id);
  }

  radio(p, kind) {
    const team = this.policy.teamFor(p);
    this.policy._emit('comm', { team, by: idOf(p), comm: kind, squad: this.policy.squads.squadOf(p.id) });
  }

  request(p, kind, now) {
    const team = this.policy.teamFor(p);
    let vehicleId = null;
    if (kind === 'repair') {
      const hull = this.repairTarget(p, team);
      if (!hull) return false;
      vehicleId = String(hull.id);
    }
    if (kind === 'ride' && p.vehicleId) return false;
    if (kind === 'ammo' && p.vehicleId) return false;
    const id = idOf(p);
    const request = { seq: ++this.seq, kind, by: id, team, squad: this.policy.squads.squadOf(id), at: now,
      until: now + this.rules.requestMs, vehicleId, responder: null, served: false };
    this.requests.delete(id);
    this.requests.set(id, request);
    // A team keeps at most maxPerTeam live markers: the oldest gives way.
    const own = [...this.requests.values()].filter(r => r.team === team);
    while (own.length > this.rules.maxPerTeam) this.requests.delete(own.shift().by);
    this.policy._emit('comm', { team, by: id, comm: kind, squad: request.squad, seq: request.seq });
    return true;
  }

  /** NEED REPAIR names the requester's own hull, or the nearest damaged friendly hull within repairReach. */
  repairTarget(p, team) {
    const vehicles = this.vehicles;
    if (!vehicles) return null;
    const damaged = v => v && v.hp > 0 && v.team === team && v.hp < (vehicleMaxHp(v.type) || v.maxHp || Infinity);
    if (p.vehicleId) { const own = vehicles.get(p.vehicleId); return damaged(own) ? own : null; }
    let best = null, bestD = this.rules.repairReach;
    for (const v of vehicles.values()) {
      if (!damaged(v)) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d <= bestD) { best = v; bestD = d; }
    }
    return best;
  }

  /** A bot took request `seq` (bot commander). Announced once per responder. */
  answer(seq, responderId) {
    const request = [...this.requests.values()].find(r => r.seq === seq);
    if (!request || request.responder === String(responderId)) return false;
    request.responder = String(responderId);
    this.policy._emit('comm_answer', { team: request.team, seq, comm: request.kind, by: request.by, responder: request.responder });
    return true;
  }

  /** Live requests, optionally of one team (bot commander). */
  list(team = null) { return [...this.requests.values()].filter(r => !team || r.team === team); }

  /** Where a request marker stands: the named hull, else the requester (its downed body while down). */
  position(request) {
    if (request.vehicleId) {
      const v = this.vehicles?.get(request.vehicleId);
      if (v) return { x: v.x, y: v.y, z: v.z };
    }
    const p = this.policy._entity(request.by);
    if (!p) return null;
    if (p.state !== 'alive') {
      const body = this.policy.roles?.downedBodies?.().find(b => String(b.id) === request.by);
      return body ? { x: body.x, y: body.y, z: body.z } : null;
    }
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Per tick: serve, expire and drop requests; send the bot acknowledgements that are due. */
  tick(now) {
    for (const [id, request] of this.requests) if (this.over(request, now)) this.requests.delete(id);
    while (this.acks.length && this.acks[0].at <= now) {
      const ack = this.acks.shift();
      const bot = this.policy._entity(ack.id);
      if (bot?.state === 'alive' && this.policy.squads.squadOf(ack.id) === ack.squad) this.radio(bot, 'yes');
    }
  }

  over(request, now) {
    if (now > request.until) return true;
    const p = this.policy._entity(request.by);
    if (!p || this.policy.teamFor(p) !== request.team) return true;
    const down = this.policy.roles?.isDown?.(p) === true;
    if (p.state !== 'alive' && !(request.kind === 'medic' && down)) return true;
    switch (request.kind) {
      case 'medic': {
        const max = Number.isFinite(p.maxHp) && p.maxHp > 0 ? p.maxHp : 100;
        return request.served && p.state === 'alive' && !down && p.hp >= max * this.rules.medicDoneHp;
      }
      case 'ammo': return (this.policy.roles?.refilledAt?.(p) ?? -Infinity) > request.at;
      case 'repair': {
        const v = this.vehicles?.get(request.vehicleId);
        return !v || !(v.hp > 0) || v.hp >= (vehicleMaxHp(v.type) || v.maxHp || 0);
      }
      case 'ride': return !!p.vehicleId;
      default: return true;
    }
  }

  /** Policy event tap: a heal or revive of a medic requester serves the request. */
  onEvent(kind, fields) {
    if (kind !== 'heal' && kind !== 'revive') return;
    const request = this.requests.get(String(fields?.id));
    if (request?.kind === 'medic') request.served = true;
  }

  /** A human leader's order: the first living bot of the squad radios AFFIRMATIVE a moment later. */
  orderIssued(fields) {
    const leader = this.policy._entity(fields.by);
    if (!leader || leader.bot || fields.flag == null) return;
    const mate = this.policy.squads.membersOf(fields.team, fields.squad)
      .map(id => this.policy._entity(id)).find(e => e?.bot && e.state === 'alive');
    if (mate) this.acks.push({ id: String(mate.id), squad: fields.squad, at: this.policy.now + this.rules.ackDelayMs });
  }

  /** The requester's `cqc` player field (shared/conquest-comms.js encodeCommField), or undefined. */
  fieldOf(playerId) {
    const request = this.requests.get(String(playerId));
    return request ? encodeCommField(request) : undefined;
  }

  remove(playerId) {
    const id = String(playerId);
    this.requests.delete(id);
    this.lastAt.delete(id);
    for (const request of this.requests.values()) if (request.responder === id) request.responder = null;
  }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    const request = this.requests.get(prior);
    if (request) { this.requests.delete(prior); request.by = next; this.requests.set(next, request); }
    for (const r of this.requests.values()) if (r.responder === prior) r.responder = null;
    this.lastAt.delete(prior);
  }
}

