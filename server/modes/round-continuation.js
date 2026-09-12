import { randomUUID } from 'node:crypto';

const APPROVAL_RATIO = 0.4;
const COUNTDOWN_MS = 5000;

/** One vote per connected human, scoped to the current round result. */
export class RoundContinuation {
  constructor(entities, now) {
    this.entities = entities;
    this.now = now;
    this.clear();
  }

  clear() {
    this.id = null;
    this.approved = new Set();
    this.endsAt = null;
    this.results = [];
  }

  begin() {
    this.clear();
    this.id = randomUUID();
    this.results = [...this.entities.values()].filter(p => !p.npcRole).map(p => ({
      id: String(p.id), name: p.name, team: p.team, bot: !!p.bot,
      kills: p.kills, deaths: p.deaths, score: p.score, state: p.state,
      ping: p.ping,
    }));
  }

  sync() {
    const humans = [...this.entities.values()].filter(p => !p.bot && !p.npcRole);
    this.eligible = new Set(humans.map(p => String(p.id)));
    for (const id of this.approved) if (!this.eligible.has(id)) this.approved.delete(id);
    this.required = Math.max(1, Math.ceil(this.eligible.size * APPROVAL_RATIO));
    if (this.approved.size < this.required) this.endsAt = null;
    else if (this.endsAt === null) this.endsAt = this.now() + COUNTDOWN_MS;
  }

  approve(playerId, roundId) {
    if (!this.id || roundId !== this.id) return false;
    this.sync();
    if (!this.eligible.has(playerId)) return false;
    this.approved.add(playerId);
    this.sync();
    return true;
  }

  snapshot() {
    return {
      id: this.id, approved: [...this.approved], eligible: this.eligible.size,
      required: this.required, ratio: APPROVAL_RATIO,
    };
  }
}
