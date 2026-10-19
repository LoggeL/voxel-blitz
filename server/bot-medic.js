// Conquest Medic bot positioning: keep the heal aura (KIT_ROLE_RULES.healRadius,
// 6 m feet to feet) on living squad mates instead of walking a private route.
//
// With no body to revive and no hurt mate to walk to (BotCommander.roleGoal), a
// Medic trails one mate: the nearest living on-foot squad mate it can catch up
// with, else a teammate of another squad bound for the same flag. It stands
// MEDIC_BOT_RULES.trailDist behind that mate (on the side away from the flag),
// so the pulse covers the mate while it walks, stages, holds cover or stands in
// the capture zone. A mate far behind on the way to the objective (a fresh HQ
// spawn) is not walked back to, and a Recon on its overwatch node is a last
// choice. Every input is authoritative entity state.

export const MEDIC_BOT_RULES = Object.freeze({
  /** m behind the trailed mate; with `trailArrive` the Medic stays well inside the aura. */
  trailDist: 2.5,
  trailArrive: 1.5,
  /**
   * s of the mate's ground velocity the spot leads by: a bot walks the last 7 m of a
   * route and sprints beyond, so an unled spot behind a sprinting mate fell back to
   * 7-10 m, outside the aura. Below `trailLeadMinSpeed` m/s the spot does not lead.
   */
  trailLeadS: 1.2,
  trailLeadMinSpeed: 1.5,
  /** m: mates farther than this (flat) from the Medic are not trailed. */
  trailRange: 140,
  /** m: a mate this much farther from the flag than the Medic is behind it (not walked back to) ... */
  trailBacktrack: 30,
  /** ... unless it is this close. */
  trailNear: 15,
  /** m of score added for a teammate outside the squad, and for a Recon (overwatch nodes sit 60-120 m out). */
  otherSquadPenalty: 25,
  reconPenalty: 45,
  /** m: other-squad teammates only count when bound for a flag this close to the Medic's. */
  sameFlagRadius: 30,
  /**
   * Revive reach for Medic bots (m, flat): a body is worth the run while its
   * down window (CONQUEST_RULES.reviveWindowMs, 8 s) outlasts the sprint at
   * `reviveRunSpeed` m/s (a sprinting bot covers 6-6.5 m/s) plus the 1.2 s hold,
   * so a fresh body 40 m off still qualifies and one about to expire does not.
   */
  reviveRange: 40,
  reviveRunSpeed: 6,
  /** m a squad spawn must beat the best flag spawn by for a Medic (others: SQUAD_SPAWN_PENALTY, 45). */
  squadSpawnPenalty: 0,
});

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const finite = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);

/** Whether a body `d` m away is still worth a revive run before its down window ends. */
export function reviveRunInTime(d, until, now, holdMs) {
  const r = MEDIC_BOT_RULES;
  return Number.isFinite(until) && until > now + (d / r.reviveRunSpeed) * 1000 + holdMs;
}

/**
 * The mate a Medic bot trails, or null.
 * @param {object} commander BotCommander (game, teamOf, kitOf, objectiveFlagOf)
 * @param {object} p the Medic entity
 * @param {object} ts the team state (memberSquad)
 * @param {object} flag the flag the Medic's order is about ({x, z})
 */
export function medicTrailMate(commander, p, ts, flag) {
  const r = MEDIC_BOT_RULES, game = commander.game, team = commander.teamOf(p);
  const squad = ts?.memberSquad?.get(String(p.id));
  const members = new Set(squad?.members ?? []);
  const selfToFlag = flag ? flat(p, flag) : 0;
  let best = null;
  for (const mate of game.entities.values()) {
    if (mate === p || mate.state !== 'alive' || mate.vehicleId || mate.npcRole || !finite(mate)) continue;
    if (commander.teamOf(mate) !== team) continue;
    const d = flat(mate, p);
    if (d > r.trailRange) continue;
    const ownSquad = members.has(String(mate.id));
    if (!ownSquad) {
      // Another squad's soldier only when it is bound for the same flag.
      const theirs = commander.objectiveFlagOf?.(mate);
      if (!flag || !theirs || flat(theirs, flag) > r.sameFlagRadius) continue;
    }
    // Do not run back to a mate far behind on the way to the objective.
    if (flag && d > r.trailNear && flat(mate, flag) > selfToFlag + r.trailBacktrack) continue;
    // Two Medics trailing each other would park side by side short of the flag.
    const kit = commander.kitOf(mate);
    if (kit === 'medic') continue;
    let score = d + (ownSquad ? 0 : r.otherSquadPenalty);
    if (kit === 'recon') score += r.reconPenalty;
    if (!best || score < best.score) best = { mate, score };
  }
  return best?.mate ?? null;
}

/**
 * Where a Medic stands to keep the aura on `mate`: trailDist behind it, on the
 * side away from the flag (toward the Medic when the mate is on the flag's centre).
 * A moving mate is led instead, so the Medic keeps its sprint on the mate's heels.
 */
export function medicTrailSpot(p, mate, flag) {
  const r = MEDIC_BOT_RULES;
  let dx = flag ? mate.x - flag.x : p.x - mate.x, dz = flag ? mate.z - flag.z : p.z - mate.z;
  if (Math.hypot(dx, dz) < 3) { dx = p.x - mate.x; dz = p.z - mate.z; }
  const len = Math.hypot(dx, dz);
  const speed = Math.hypot(mate.vx || 0, mate.vz || 0);
  const lead = speed >= r.trailLeadMinSpeed ? r.trailLeadS : 0;
  const x = mate.x + (mate.vx || 0) * lead, z = mate.z + (mate.vz || 0) * lead;
  if (len < 0.01 || lead) return { x, y: mate.y, z };
  return { x: x + dx / len * r.trailDist, y: mate.y, z: z + dz / len * r.trailDist };
}
