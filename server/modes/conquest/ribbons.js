import { MEDALS, MEDAL_IDS, RIBBONS, RIBBON_IDS } from '../../../shared/conquest-contract.js';

/** Score reason -> ribbon ids that count it (RIBBONS[id].reasons). */
const RIBBONS_BY_REASON = new Map();
for (const id of RIBBON_IDS) for (const reason of RIBBONS[id].reasons) RIBBONS_BY_REASON.set(reason, [...RIBBONS_BY_REASON.get(reason) || [], id]);

/**
 * Conquest ribbons and medals. The score ledger reports every paid award
 * (`onAward`); a ribbon is earned when its reason count reaches the RIBBONS
 * threshold (once per life for `life` ribbons, at every multiple for `match`
 * ribbons). `host.ribbon(id, ribbonId, count)` pays and announces it. Medals
 * are decided once by `finish()` at match end from the ribbon counts.
 */
export class RibbonTracker {
  /** `host`: ribbon(playerId, ribbonId, count) pays SCORE_POINTS.ribbon and emits the event. */
  constructor(host) {
    this.host = host;
    this.reset();
  }

  reset() {
    /** id -> { match: {reason: n}, life: {reason: n}, lifePaid: Set, ribbons: {ribbonId: n}, medals: [medalId] } */
    this.players = new Map();
  }

  /** A paid score award (never a `ribbon` itself: no ribbon counts its own bonus). */
  onAward(playerId, reason) {
    const ribbons = RIBBONS_BY_REASON.get(reason);
    if (!ribbons || playerId == null) return;
    const row = this._row(String(playerId));
    row.match[reason] = (row.match[reason] || 0) + 1;
    row.life[reason] = (row.life[reason] || 0) + 1;
    for (const ribbon of ribbons) {
      const rule = RIBBONS[ribbon];
      if (rule.scope === 'life') {
        if (row.lifePaid.has(ribbon) || row.life[reason] < rule.count) continue;
        row.lifePaid.add(ribbon);
      } else if (row.match[reason] % rule.count !== 0) continue;
      row.ribbons[ribbon] = (row.ribbons[ribbon] || 0) + 1;
      this.host.ribbon?.(String(playerId), ribbon, row.ribbons[ribbon]);
    }
  }

  /** A death ends the life: `life` counters start again. */
  onDeath(playerId) {
    const row = this.players.get(String(playerId));
    if (!row) return;
    row.life = {};
    row.lifePaid.clear();
  }

  /** Ribbon counts in RIBBON_IDS order (results row `cqr`). */
  ribbonRow(playerId) {
    const row = this.players.get(String(playerId));
    return RIBBON_IDS.map(id => row?.ribbons[id] || 0);
  }

  /** Earned medals as MEDAL_IDS indices (results row `cqm`); empty until finish(). */
  medalRow(playerId) {
    const row = this.players.get(String(playerId));
    return (row?.medals || []).map(id => MEDAL_IDS.indexOf(id));
  }

  /**
   * Match end: decide every player's medals from the ribbon counts, once.
   * Returns [[playerId, medalId], ...] in player and MEDAL_IDS order.
   */
  finish(playerIds = this.players.keys()) {
    const awarded = [];
    for (const key of playerIds) {
      const id = String(key);
      const row = this._row(id);
      const total = RIBBON_IDS.reduce((sum, ribbon) => sum + (row.ribbons[ribbon] || 0), 0);
      row.medals = MEDAL_IDS.filter(medal => {
        const rule = MEDALS[medal];
        return (rule.ribbon ? row.ribbons[rule.ribbon] || 0 : total) >= rule.count;
      });
      for (const medal of row.medals) awarded.push([id, medal]);
    }
    return awarded;
  }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    if (!this.players.has(prior)) return;
    this.players.set(next, this.players.get(prior));
    this.players.delete(prior);
  }

  remove(playerId) { this.players.delete(String(playerId)); }

  _row(id) {
    let row = this.players.get(id);
    if (!row) { row = { match: {}, life: {}, lifePaid: new Set(), ribbons: {}, medals: [] }; this.players.set(id, row); }
    return row;
  }
}
