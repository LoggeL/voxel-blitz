import { COMM_RULES, orderStance } from '../../../shared/conquest-comms.js';

const keyOf = (team, squadId) => `${team}:${squadId | 0}`;

/**
 * Squad orders (docs/conquest.md "Squad orders and the comm rose"). One
 * order per squad: a flag. The stance is never stored: an own flag is
 * defended, any other attacked (orderStance), so a captured attack flag turns
 * into a defend order on its own. A human squad leader orders through the
 * comm rose or the full map (`issue`); a squad a bot leads carries the bot
 * commander's flag (`setBotOrder`). An order stands only while the player
 * who gave it leads the squad; every change emits `squad_order`.
 *
 * `host` supplies now(), emit(kind, fields), squads (the SquadRoster),
 * flags() (rich capture rows), teamFor(p) and entity(id).
 */
export class SquadOrders {
  constructor(host, rules = COMM_RULES) {
    this.host = host;
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.orders = new Map();   // `${team}:${squadId}` -> { team, squadId, flagId, by, human, at }
    this.issuedAt = new Map(); // leader id -> last accepted issue (cooldown)
  }

  get(team, squadId) { return this.orders.get(keyOf(team, squadId)) ?? null; }
  flagFor(team, squadId) { return this.get(team, squadId)?.flagId ?? null; }

  /** The order of a player's squad, or null. */
  orderOf(player) {
    const entity = this.host.entity(player);
    if (!entity) return null;
    const team = this.host.teamFor(entity);
    return this.get(team, this.host.squads.squadOf(entity.id));
  }

  /** The order's stance for its team right now ('attack' | 'defend'), or null. */
  stanceOf(order) {
    if (!order) return null;
    return orderStance(this.host.flags().find(f => f.id === order.flagId), order.team);
  }

  /**
   * A squad leader's order on a flag ('' or null clears it). Refused for
   * anyone but the leader, for unknown flags and within orderCooldownMs of the
   * leader's last order. Re-issuing the standing order is accepted unchanged.
   */
  issue(player, flagId) {
    const entity = this.host.entity(player);
    if (!entity) return false;
    const id = String(entity.id);
    const team = this.host.teamFor(entity);
    const squadId = this.host.squads.squadOf(id);
    if (!squadId || this.host.squads.leaderOf(team, squadId) !== id) return false;
    const clear = flagId == null || flagId === '';
    if (!clear && !this.host.flags().some(f => f.id === flagId)) return false;
    const current = this.get(team, squadId);
    if (clear ? !current : current?.flagId === flagId && current.by === id) return true;
    const now = this.host.now();
    if (now - (this.issuedAt.get(id) ?? -Infinity) < this.rules.orderCooldownMs) return false;
    this.issuedAt.set(id, now);
    this._set(team, squadId, clear ? null : flagId, id, !entity.bot);
    return true;
  }

  /** Bot commander: the flag of a squad whose leader is a bot (null clears). Humans lead with their own orders. */
  setBotOrder(team, squadId, flagId) {
    const leaderId = this.host.squads.leaderOf(team, squadId);
    const leader = leaderId != null ? this.host.entity(leaderId) : null;
    if (!leader?.bot) return false;
    const current = this.get(team, squadId);
    if ((current?.flagId ?? null) === (flagId ?? null) && (!current || current.by === String(leaderId))) return true;
    if (flagId != null && !this.host.flags().some(f => f.id === flagId)) return false;
    this._set(team, squadId, flagId ?? null, String(leaderId), false);
    return true;
  }

  /** Drop orders whose squad is gone or whose giver no longer leads it (a leader left or was replaced). */
  sync() {
    for (const [key, order] of this.orders) {
      const leaderId = this.host.squads.leaderOf(order.team, order.squadId);
      const leader = leaderId != null ? this.host.entity(leaderId) : null;
      if (leaderId === order.by && leader && !!leader.bot === !order.human) continue;
      this.orders.delete(key);
      this.host.emit('squad_order', { team: order.team, squad: order.squadId, flag: null, by: order.by });
    }
  }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const order of this.orders.values()) if (order.by === prior) order.by = next;
    if (this.issuedAt.has(prior)) { this.issuedAt.set(next, this.issuedAt.get(prior)); this.issuedAt.delete(prior); }
  }

  remove(playerId) { this.issuedAt.delete(String(playerId)); }

  _set(team, squadId, flagId, by, human) {
    const key = keyOf(team, squadId);
    if (flagId == null) this.orders.delete(key);
    else this.orders.set(key, { team, squadId, flagId, by, human, at: this.host.now() });
    this.host.emit('squad_order', { team, squad: squadId, flag: flagId, by });
  }
}
