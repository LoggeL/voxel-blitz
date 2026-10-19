// Conquest bot capture flow: order commitment, staying on a capture, and
// taking empty flags on the way. Hooks for BotCommander (bot-commander.js).
//
// The commander replans every 500 ms, and on Frontier (flags 176-275 m apart)
// a re-plan that flips a squad between two flags mid-walk (the stalemate flank
// toggling with the contested line, or a lane swap as centroids move) left it
// wandering between them without reaching either. So:
//  - an attack order keeps its flag for FLAG_FLOW_RULES.attackCommitMs (a flank
//    order for flankCommitMs) against another attack plan; a capture under way
//    (squad bots in the zone) extends that up to twice as long and also holds
//    against a defend call or a flank. A flag taken, an all-in home defence, a
//    defend call or a new flank with nobody in the zone or the end of the
//    commitment frees the squad;
//  - a bot standing in a flag its team is taking (or holding even) stays in
//    the zone until the flag turns, whatever its squad's order says; only a
//    defend order pulls it out early, unless the flag is about to turn;
//  - a bot passing an enemy or neutral flag nobody defends takes it on the way.
// Every input is authoritative mode, entity and team-knowledge state.

export const FLAG_FLOW_RULES = Object.freeze({
  /** ms an attack order keeps its flag against a re-plan (a flank order: flankCommitMs). */
  attackCommitMs: 45000,
  flankCommitMs: 75000,
  /** Squad bots in the zone extend the commitment up to this multiple of it. */
  zoneCommitFactor: 2,
  /** Control left to the next transition (0-1, a half is 8 s alone) below which a defend order waits. */
  defendBreakRemaining: 0.4,
  /** Share of the radius (and the 8 m height band) that counts as standing in the zone. */
  zoneShare: 0.85,
  zoneDy: 8,
  /** m beyond a flag's radius where a passing bot detours to take an undefended flag. */
  passRadius: 40,
  /** A detour takes at most this many bots of a team onto one flag. */
  passCrew: 2,
});

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const opposite = team => (team === 'alpha' ? 'bravo' : 'alpha');

/** Whether `p` stands inside the counting zone of `flag`. */
export function inFlagZone(p, flag, share = FLAG_FLOW_RULES.zoneShare) {
  return flat(p, flag) <= flag.radius * share && Math.abs(p.y - flag.y) <= FLAG_FLOW_RULES.zoneDy;
}

/** On-foot bots of a squad standing in the zone of `flag`. */
function squadInZone(commander, squad, flag) {
  let n = 0;
  for (const id of squad.members) {
    const p = commander.game.entities.get(id);
    if (p?.state === 'alive' && p.bot && !p.vehicleId && inFlagZone(p, flag, 1)) n++;
  }
  return n;
}

/**
 * Whether a squad keeps its prior attack order instead of the re-plan's `want`
 * ({stance, flagId, allIn?, flank?} or undefined).
 */
export function keepAttackOrder(commander, squad, prior, want, view, ts, now) {
  const r = FLAG_FLOW_RULES;
  if (!prior || prior.stance !== 'attack' || !want || want.allIn) return false;
  if (want.stance === 'attack' && want.flagId === prior.flagId) return false;
  const flag = view.flags.find(f => f.id === prior.flagId);
  if (!flag || flag.owner === ts.team) return false;
  const limit = prior.flank ? r.flankCommitMs : r.attackCommitMs;
  const age = now - prior.issuedAt;
  const capturing = squadInZone(commander, squad, flag) > 0;
  if (age >= limit * (capturing ? r.zoneCommitFactor : 1)) return false;
  if (want.stance === 'defend' && !capturing) return false;
  // A stalled line still sends its flankers at once; the flank order then sticks.
  if (want.flank && !prior.flank && !capturing) return false;
  return true;
}

/** Control `team` still has to move `flag` by before its next transition (neutralize or capture). */
export function turnRemaining(flag, team) {
  const s = team === 'alpha' ? 1 : -1, c = Number.isFinite(flag.control) ? flag.control : 0;
  if (flag.owner && flag.owner !== team) return Math.min(1, Math.max(0, -c * s));
  return Math.min(2, Math.max(0, 1 - c * s));
}

/**
 * The flag a bot on foot stays on whatever its order says: a flag its team
 * does not own (or owns and is losing) where it stands in the zone and its
 * team has at least as many bodies counted as the enemy, or null. A defend
 * order (`order`) only waits for a flag about to turn.
 */
export function committedFlag(commander, p, team, view, order = null) {
  const enemy = opposite(team);
  for (const flag of view.flags) {
    if (!inFlagZone(p, flag)) continue;
    const presence = commander.presence.get(flag.id);
    if (!presence || presence[team] < 1 || presence[team] < presence[enemy]) continue;
    if (flag.owner !== team) {
      if (order?.stance === 'defend' && order.flagId !== flag.id && turnRemaining(flag, team) > FLAG_FLOW_RULES.defendBreakRemaining) continue;
      return flag;
    }
    if (flag.state === 'neutralizing' || flag.state === 'contested') return flag;
  }
  return null;
}

/**
 * An enemy or neutral flag within passRadius of its edge that no enemy is
 * known to hold and fewer than passCrew teammates already stand on: a bot
 * walking past takes it on the way (null when there is none).
 */
export function passingFlag(commander, p, ts, view, exceptId) {
  const r = FLAG_FLOW_RULES;
  let best = null;
  for (const flag of view.flags) {
    if (flag.owner === ts.team || flag.id === exceptId) continue;
    const d = flat(p, flag);
    if (d > flag.radius + r.passRadius || Math.abs(p.y - flag.y) > 12) continue;
    if (commander.defenders(flag, ts) > 0) continue;
    if ((commander.presence.get(flag.id)?.[ts.team] ?? 0) >= r.passCrew && !inFlagZone(p, flag, 1)) continue;
    if (!best || d < best.d) best = { flag, d };
  }
  return best?.flag ?? null;
}
