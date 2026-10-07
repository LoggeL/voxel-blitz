import { CONQUEST_TEAMS } from '../../../shared/conquest-contract.js';

/**
 * Per-team squads of at most `size` members.
 *
 * A team of n players always has ceil(n/size) squads whose sizes differ by at
 * most one. Joins go to the smallest squad (join order breaks ties by squad
 * id); when a new squad must open, the newest members of the largest squads
 * move into it. Leaving dissolves the smallest squad once the team needs one
 * fewer. The leader is the member who has been in the squad longest.
 * Squad ids are 1-based per team and stable while the squad exists.
 */
export class SquadRoster {
  constructor(size = 4) {
    this.size = Math.max(1, Math.trunc(size) || 4);
    this.clear();
  }

  clear() {
    this.seq = 0;
    this.members = new Map(); // playerId -> { team, squadId, since }
    this.squads = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, new Map()])); // squadId -> Set(ids)
  }

  /** Add or move a player to `team`; returns its squad id. */
  add(playerId, team) {
    const id = String(playerId);
    if (!this.squads[team]) return 0;
    const current = this.members.get(id);
    if (current?.team === team) return current.squadId;
    if (current) this.remove(id);
    const squads = this.squads[team];
    const needed = Math.ceil((this._teamSize(team) + 1) / this.size);
    if (squads.size < needed) squads.set(this._freeSquadId(team), new Set());
    const target = this._smallest(team);
    this._place(id, team, target);
    this._rebalance(team);
    return this.members.get(id)?.squadId ?? 0;
  }

  remove(playerId) {
    const id = String(playerId);
    const member = this.members.get(id);
    if (!member) return false;
    this.members.delete(id);
    const squads = this.squads[member.team];
    squads.get(member.squadId)?.delete(id);
    if (!squads.get(member.squadId)?.size) squads.delete(member.squadId);
    const needed = Math.ceil(this._teamSize(member.team) / this.size);
    while (squads.size > needed) this._dissolve(member.team);
    this._rebalance(member.team);
    return true;
  }

  /** A bot handed to a human keeps its squad slot and seniority. */
  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    const member = this.members.get(prior);
    if (!member || this.members.has(next)) return false;
    this.members.delete(prior);
    this.members.set(next, member);
    const set = this.squads[member.team].get(member.squadId);
    set.delete(prior);
    set.add(next);
    return true;
  }

  squadOf(playerId) { return this.members.get(String(playerId))?.squadId ?? 0; }
  teamOf(playerId) { return this.members.get(String(playerId))?.team ?? null; }

  /** Ids of the squad, longest-standing first. */
  membersOf(team, squadId) {
    const set = this.squads[team]?.get(squadId);
    if (!set) return [];
    return [...set].sort((a, b) => this.members.get(a).since - this.members.get(b).since);
  }

  leaderOf(team, squadId) { return this.membersOf(team, squadId)[0] ?? null; }

  /** Same team and squad, distinct players. */
  areSquadmates(a, b) {
    const left = this.members.get(String(a)), right = this.members.get(String(b));
    return !!left && !!right && String(a) !== String(b) && left.team === right.team && left.squadId === right.squadId;
  }

  /** `[[team, squadId, leaderId], ...]` in team then id order. */
  tuples() {
    const rows = [];
    for (const team of CONQUEST_TEAMS) {
      for (const squadId of [...this.squads[team].keys()].sort((a, b) => a - b)) {
        const leader = this.leaderOf(team, squadId);
        if (leader != null) rows.push([team, squadId, leader]);
      }
    }
    return rows;
  }

  /** Map<playerId, {team, squadId, leaderId}>. */
  map() {
    const out = new Map();
    for (const [id, member] of this.members) {
      out.set(id, { team: member.team, squadId: member.squadId, leaderId: this.leaderOf(member.team, member.squadId) });
    }
    return out;
  }

  sizes(team) { return [...this.squads[team].values()].map(set => set.size); }

  _teamSize(team) { let n = 0; for (const set of this.squads[team].values()) n += set.size; return n; }

  _freeSquadId(team) { let id = 1; while (this.squads[team].has(id)) id++; return id; }

  _smallest(team, except = null) {
    let best = null, bestSize = Infinity;
    for (const [squadId, set] of [...this.squads[team]].sort((a, b) => a[0] - b[0])) {
      if (squadId === except) continue;
      if (set.size < bestSize) { best = squadId; bestSize = set.size; }
    }
    return best;
  }

  _largest(team) {
    let best = null, bestSize = -1;
    for (const [squadId, set] of [...this.squads[team]].sort((a, b) => a[0] - b[0])) {
      if (set.size > bestSize) { best = squadId; bestSize = set.size; }
    }
    return best;
  }

  _place(id, team, squadId) {
    this.squads[team].get(squadId).add(id);
    this.members.set(id, { team, squadId, since: ++this.seq });
  }

  /** The smallest squad (highest id on ties) folds into the others. */
  _dissolve(team) {
    const squads = this.squads[team];
    let victim = null, size = Infinity;
    for (const [squadId, set] of [...squads].sort((a, b) => b[0] - a[0])) {
      if (set.size < size) { victim = squadId; size = set.size; }
    }
    const orphans = this.membersOf(team, victim);
    squads.delete(victim);
    for (const id of orphans) this._place(id, team, this._smallest(team));
  }

  /** Move the newest members of the largest squad into the smallest until sizes differ by <= 1. */
  _rebalance(team) {
    for (let guard = 0; guard < 64; guard++) {
      const big = this._largest(team), small = this._smallest(team);
      if (big == null || small == null || big === small) return;
      const squads = this.squads[team];
      if (squads.get(big).size - squads.get(small).size <= 1) return;
      const mover = this.membersOf(team, big).at(-1);
      squads.get(big).delete(mover);
      this._place(mover, team, small);
    }
  }
}
