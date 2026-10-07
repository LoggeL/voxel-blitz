import { CONQUEST_TEAMS } from '../../../shared/conquest-contract.js';
import { advanceControl, flagPresence, oppositeTeam, teamSign } from '../../../shared/conquest.js';

const TEAM_SET = new Set(CONQUEST_TEAMS);
const DEFAULT_RADIUS = 20;
/**
 * Control a threat must take off a held flag before holding it pays 'defend':
 * an enemy stepping in and out of a full flag (a 1v1 contest that never moves
 * control) is not a defence and must not be farmable. 0.1 is ~0.8 s of one
 * body neutralizing at the base rate.
 */
const DEFEND_MIN_DENT = 0.1;
const pointOf = value => [value?.x, value?.y, value?.z].every(Number.isFinite)
  ? { x: value.x, y: value.y, z: value.z } : null;

/**
 * Authoritative flag zones. Owns the rich flag rows (`flags`, read by bots
 * and the policy view) and the per-flag bookkeeping the score ledger needs:
 * who pushed the current capture attempt and who held a threatened flag.
 */
export class CaptureSystem {
  constructor(rules) {
    this.rules = rules;
    this.flags = [];
    this.tracks = new Map();
  }

  /** Home flags start owned at full control; every other flag starts neutral. */
  reset(metaFlags = []) {
    this.flags = (Array.isArray(metaFlags) ? metaFlags : []).filter(f => f && typeof f.id === 'string' && pointOf(f))
      .map(f => {
        const home = TEAM_SET.has(f.home) ? f.home : null;
        return {
          id: f.id, name: typeof f.name === 'string' ? f.name : f.id, site: f.site ?? null,
          x: f.x, y: f.y, z: f.z,
          radius: Number.isFinite(f.radius) && f.radius > 0 ? f.radius : DEFAULT_RADIUS,
          home, spawns: Array.isArray(f.spawns) ? f.spawns.map(pointOf).filter(Boolean) : [],
          owner: home, control: teamSign(home), state: 'idle', mover: null,
          alpha: 0, bravo: 0,
        };
      });
    this.tracks = new Map(this.flags.map(f => [f.id, { attempt: null, threat: null }]));
  }

  flag(id) { return this.flags.find(f => f.id === id) || null; }

  held() {
    const counts = Object.fromEntries(CONQUEST_TEAMS.map(team => [team, 0]));
    for (const flag of this.flags) if (flag.owner) counts[flag.owner]++;
    return counts;
  }

  /**
   * Advance every zone with this tick's presence list. Returns outcomes in
   * order: `{kind:'state'|'neutralized'|'captured'|'defended', flag, team,
   * prev?, present?, assists?, defenders?}`.
   */
  step(dtMs, presence) {
    const outcomes = [];
    for (const flag of this.flags) {
      const counts = flagPresence(flag, presence, this.rules);
      flag.alpha = counts.alpha;
      flag.bravo = counts.bravo;
      const ownerBefore = flag.owner;
      const transitions = advanceControl(flag, counts, dtMs, this.rules);
      const track = this.tracks.get(flag.id);
      this._trackAttempt(flag, counts, track);
      this._trackThreat(flag, ownerBefore, counts, track);
      for (const t of transitions) {
        if (t.kind === 'neutralized') {
          outcomes.push({ kind: 'neutralized', flag, team: t.team, prev: t.prev, present: counts.ids[t.team].slice() });
          track.threat = null;
        } else if (t.kind === 'captured') {
          const present = counts.ids[t.team].slice();
          const contributors = track.attempt?.team === t.team ? track.attempt.contributors : new Set();
          outcomes.push({ kind: 'captured', flag, team: t.team, present,
            assists: [...contributors].filter(id => !present.includes(id)) });
          track.attempt = null;
        } else {
          outcomes.push({ kind: 'state', flag, state: t.state, team: t.team });
        }
      }
      if (flag.state === 'idle') {
        if (track.threat && flag.owner === track.threat.owner && track.threat.defenders.size
          && track.threat.dent >= DEFEND_MIN_DENT - 1e-9) {
          outcomes.push({ kind: 'defended', flag, team: flag.owner, defenders: [...track.threat.defenders] });
        }
        track.threat = null;
        track.attempt = null;
      }
    }
    return outcomes;
  }

  _trackAttempt(flag, counts, track) {
    if (flag.state !== 'capturing' && flag.state !== 'neutralizing') return;
    const team = flag.mover;
    if (!TEAM_SET.has(team)) return;
    if (track.attempt?.team !== team) track.attempt = { team, contributors: new Set() };
    for (const id of counts.ids[team]) track.attempt.contributors.add(id);
  }

  /**
   * A threat starts when enemies move or freeze an owned flag; owners present
   * during it defend, and it pays only once it dented control (DEFEND_MIN_DENT).
   */
  _trackThreat(flag, ownerBefore, counts, track) {
    const owner = flag.owner;
    if (!owner || owner !== ownerBefore) return;
    const enemyActive = counts[oppositeTeam(owner)] > 0
      && (flag.state === 'neutralizing' || flag.state === 'contested');
    if (enemyActive && !track.threat) track.threat = { owner, defenders: new Set(), dent: 0 };
    if (!track.threat) return;
    // Deepest the owner's control fell during this threat.
    track.threat.dent = Math.max(track.threat.dent, 1 - flag.control * teamSign(owner));
    if (flag.state === 'contested' || (flag.state === 'restoring' && flag.mover === owner)) {
      for (const id of counts.ids[owner]) track.threat.defenders.add(id);
    }
  }
}
