// Conquest bots and the ammo pouches of the fallen (docs/conquest.md "Infantry
// supply" -> "Ammo pouches"): an infantry bot below AMMO_POUCH_RULES.botNeed of
// its primary reserve walks to a pouch within botReachM when no enemy is in
// sight (no contact for botCalmMs) and its goal is not a support hold or an
// urgent objective. The pickup itself is the server's walk-over rule.
import { AMMO_POUCH_RULES, primaryReserveFraction } from '../shared/ammo-pouches.js';

/** Goals a pouch never interrupts (boarding a seat, a revive/repair hold, bomb play). */
const KEEP_GOALS = new Set(['spectate', 'board', 'perch', 'plant', 'recoverBomb', 'defuse']);
const SCAN_MS = 500;

/**
 * The pouch detour goal for bot `p` (brain `br`) instead of `goal`, or null to
 * keep `goal`. The chosen pouch sticks until it is gone or the need is met.
 */
export function pouchGoal(game, br, p, goal, now, rules = AMMO_POUCH_RULES) {
  const policy = game?.mode?.policy;
  const pouches = policy?.pouches;
  if (!pouches?.size || p?.state !== 'alive' || p.vehicleId || goal?.support || KEEP_GOALS.has(goal?.kind)) return null;
  if (now - (br.contactAt ?? -Infinity) < rules.botCalmMs || br.lastSeen) return null;
  let target = br.pouchTarget != null ? pouches.pouches.get(br.pouchTarget) ?? null : null;
  if (!target && now >= (br.pouchScanAt ?? 0)) {
    br.pouchScanAt = now + SCAN_MS;
    if (primaryReserveFraction(p, policy.roles?.loadoutOf?.(p)) < rules.botNeed) target = pouches.near(p, rules.botReachM)[0] ?? null;
  }
  br.pouchTarget = target?.id ?? null;
  if (!target) return null;
  const point = { x: target.x, y: target.y, z: target.z };
  return { kind: 'pouch', target: point, point, interact: false, arrive: 0.5, lookYaw: goal?.lookYaw };
}
