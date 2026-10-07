import { CONQUEST_TEAMS } from '../../../shared/conquest-contract.js';
import { oppositeTeam } from '../../../shared/conquest.js';

const GRAPH_SAMPLE_MS = 10000;
const GRAPH_MAX_POINTS = 130;

/**
 * Ticket accounting: deaths, revive refunds, majority bleed, ticket-low
 * announcements, the time limit with its tie-breaks and the 10 s ticket graph.
 * Pure bookkeeping; the policy emits the events it returns and ends the match.
 */
export class TicketLedger {
  constructor(rules) {
    this.rules = rules;
    this.reset(0);
  }

  reset(nowMs) {
    const max = Math.max(1, Math.trunc(this.rules.tickets) || 1);
    this.max = max;
    this.tickets = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, max]));
    this.startedAt = nowMs;
    this.endsAt = nowMs + (Number.isFinite(this.rules.timeLimitMs) ? this.rules.timeLimitMs : Infinity);
    this.bleed = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, 0]));
    this.bleedElapsed = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, 0]));
    this.lowFired = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, new Set()]));
    this.graph = [[0, max, max]];
    this.nextSampleAt = nowMs + GRAPH_SAMPLE_MS;
  }

  /** Remove `count` tickets from `team`; returns ticket_low payloads that fired. */
  charge(team, count = 1) {
    if (!(team in this.tickets) || !(count > 0)) return [];
    this.tickets[team] = Math.max(0, this.tickets[team] - Math.trunc(count));
    return this._lowCrossings(team);
  }

  /** A revive gives back one death ticket (never above the maximum). */
  refund(team, count = 1) {
    if (!(team in this.tickets) || !(count > 0)) return false;
    this.tickets[team] = Math.min(this.max, this.tickets[team] + Math.trunc(count));
    return true;
  }

  /** ms per ticket the team holding a majority of >= 3 flags drains from the other, or 0. */
  bleedRate(heldCount) {
    const table = this.rules.bleedMsByFlags || {};
    const thresholds = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    let rate = 0;
    for (const n of thresholds) if (heldCount >= n) rate = table[n];
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  }

  /**
   * Advance bleed and the graph by `dtMs` given flags held per team.
   * Returns `{low: [{team, tickets}], zero: team|null}`.
   */
  step(nowMs, dtMs, held) {
    const low = [];
    for (const team of CONQUEST_TEAMS) {
      const losing = oppositeTeam(team);
      const rate = (held[team] | 0) > (held[losing] | 0) ? this.bleedRate(held[team] | 0) : 0;
      if (rate !== this.bleed[losing]) {
        if (!rate) this.bleedElapsed[losing] = 0;
        this.bleed[losing] = rate;
      }
      if (!rate) continue;
      this.bleedElapsed[losing] += Math.max(0, dtMs);
      const pulses = Math.floor(this.bleedElapsed[losing] / rate);
      if (pulses > 0) {
        this.bleedElapsed[losing] -= pulses * rate;
        low.push(...this.charge(losing, pulses));
      }
    }
    while (nowMs >= this.nextSampleAt) {
      this._sample(this.nextSampleAt);
      this.nextSampleAt += GRAPH_SAMPLE_MS;
    }
    const zero = CONQUEST_TEAMS.find(team => this.tickets[team] <= 0) ?? null;
    return { low, zero };
  }

  timeExpired(nowMs) { return nowMs >= this.endsAt; }

  /** Time-limit winner: more tickets, then more flags held, else a draw (null). */
  timeLimitWinner(held) {
    const [a, b] = CONQUEST_TEAMS;
    if (this.tickets[a] !== this.tickets[b]) return this.tickets[a] > this.tickets[b] ? a : b;
    if ((held[a] | 0) !== (held[b] | 0)) return (held[a] | 0) > (held[b] | 0) ? a : b;
    return null;
  }

  /** Closing sample so the graph ends on the final tickets. */
  finish(nowMs) {
    const last = this.graph.at(-1);
    const t = Math.max(0, Math.round(nowMs - this.startedAt));
    if (!last || last[0] !== t) this._sample(nowMs);
  }

  snapshotBleed() { return { ...this.bleed }; }

  _sample(atMs) {
    this.graph.push([Math.max(0, Math.round(atMs - this.startedAt)), this.tickets.alpha, this.tickets.bravo]);
    if (this.graph.length > GRAPH_MAX_POINTS) {
      // Keep the first and last points and halve the resolution in between.
      const head = this.graph[0], tail = this.graph.at(-1);
      this.graph = [head, ...this.graph.slice(1, -1).filter((_, i) => i % 2 === 1), tail];
    }
  }

  _lowCrossings(team) {
    const fired = [];
    for (const fraction of this.rules.ticketLowFractions || []) {
      if (this.lowFired[team].has(fraction)) continue;
      if (this.tickets[team] <= Math.floor(this.max * fraction)) {
        this.lowFired[team].add(fraction);
        fired.push({ team, tickets: this.tickets[team] });
      }
    }
    return fired;
  }
}
