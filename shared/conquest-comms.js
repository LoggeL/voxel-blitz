/**
 * Conquest squad orders and the comm rose (docs/conquest.md "Squad orders and
 * the comm rose"). Pure data and helpers shared by the server (ConquestPolicy:
 * SquadOrders, CommSystem; the bot commander) and the client (comm rose, order
 * HUD, request markers). Tuning lives in COMM_RULES, never in the logic.
 */
import { KITS } from './conquest-contract.js';

/**
 * Wire order of the comm kinds: a `comms` row carries an index into this
 * list, so new kinds are only ever appended.
 */
export const COMM_KINDS = Object.freeze(['medic', 'ammo', 'repair', 'ride', 'yes', 'no', 'spot', 'order']);
/** The comm rose, clockwise from the top segment. */
export const COMM_ROSE = Object.freeze(['medic', 'ammo', 'repair', 'ride', 'yes', 'no', 'spot', 'order']);
/** Kinds that leave a short-lived request marker (and a bot that answers it). */
export const COMM_REQUESTS = Object.freeze(['medic', 'ammo', 'repair', 'ride']);
/** One-shot radio callouts: a line in the squad's radio feed, no marker. */
export const COMM_RADIO = Object.freeze(['yes', 'no']);

export const COMM_LABELS = Object.freeze({
  medic: 'NEED MEDIC', ammo: 'NEED AMMO', repair: 'NEED REPAIR', ride: 'NEED RIDE',
  yes: 'AFFIRMATIVE', no: 'NEGATIVE', spot: 'SPOT', order: 'ORDER',
});
/** Short marker captions above the requester. */
export const COMM_MARKER_LABELS = Object.freeze({ medic: 'MEDIC', ammo: 'AMMO', repair: 'REPAIR', ride: 'RIDE' });

export const COMM_RULES = Object.freeze({
  // A request marker lives this long unless it is answered in full first.
  requestMs: 15000,
  // Any comm (request, radio, order from the rose) at most this often per player.
  cooldownMs: 1200,
  // At most this many live requests per team; a new one pushes out the oldest.
  maxPerTeam: 6,
  // An on-foot repair request names the nearest damaged friendly hull this close.
  repairReach: 10,
  // A request is answered by a bot of the matching role within this flat range (m).
  respondRange: Object.freeze({ medic: 90, ammo: 70, repair: 90, ride: 220 }),
  // A request counts as served (and its marker clears) once this is true:
  // medic: the requester is back on its feet at this share of max HP after a heal or revive.
  medicDoneHp: 0.95,
  // ammo: the requester got a resupply from a Support aura.
  // repair: the named hull is back at full HP.
  // ride: the requester sits in any hull.
  // A Support bot answering an ammo call stands this close to the requester (aura 8 m).
  ammoStand: 4,
  // Order: the flag under the crosshair. A flag counts when the view points within
  // `orderConeRad` of its pole, or anywhere inside its zone seen from afar (atan(radius / d)).
  orderConeRad: 0.18,
  orderRange: 900,
  // Distance tie-break between flags almost in line with the view (score share per orderRange).
  orderNearBias: 0.15,
  // A leader re-issues an order at most this often.
  orderCooldownMs: 800,
  // A bot squad mate radios AFFIRMATIVE this long after a human leader's order.
  ackDelayMs: 900,
  // Bot pickups (NEED RIDE): the bot driver waits this long at the pickup point.
  pickupWaitMs: 20000,
  // A pickup driver gives up after this long without the requester aboard.
  pickupMaxMs: 60000,
});

/**
 * Who sees a request marker: the kit that can answer it (a Medic sees NEED
 * MEDIC, a Support NEED AMMO, an Engineer NEED REPAIR, anyone in a driver or
 * pilot seat NEED RIDE), plus the requester itself.
 */
export function commAudience(kind, { kit = null, driving = false } = {}) {
  const ability = KITS[kit]?.ability ?? null;
  switch (kind) {
    case 'medic': return ability === 'revive';
    case 'ammo': return ability === 'resupply';
    case 'repair': return ability === 'repair';
    case 'ride': return !!driving;
    default: return false;
  }
}

/** The kit ability that answers a request kind (ride: any bot driver), or null. */
export const COMM_RESPONDER_ABILITY = Object.freeze({ medic: 'revive', ammo: 'resupply', repair: 'repair', ride: null });

/** An order's stance follows the flag owner: an own flag is defended, any other is attacked. */
export function orderStance(flag, team) {
  if (!flag) return null;
  return flag.owner === team ? 'defend' : 'attack';
}

/** View direction from aim angles; yaw 0 faces -Z, pitch > 0 looks up (server/sim/player.js). */
export function viewDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/**
 * The flag under the crosshair, or null: the flag whose pole (2.5 m above its
 * centre) is closest in angle to the view, inside `orderConeRad`, or whose
 * zone the view crosses from afar (atan(radius / distance)). Flags beyond
 * `orderRange` never count; of two flags nearly in line the nearer wins
 * (orderNearBias). Server (comm rose order) and client (rose label)
 * use this same function.
 */
export function flagInSight(eye, yaw, pitch, flags, rules = COMM_RULES) {
  if (!eye || !Number.isFinite(eye.x) || !Array.isArray(flags)) return null;
  const view = viewDirection(Number(yaw) || 0, Number(pitch) || 0);
  let best = null, bestScore = Infinity;
  for (const flag of flags) {
    if (!flag || !Number.isFinite(flag.x) || !Number.isFinite(flag.z)) continue;
    const fy = (Number.isFinite(flag.y) ? flag.y : eye.y) + 2.5;
    const dx = flag.x - eye.x, dy = fy - eye.y, dz = flag.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > rules.orderRange) continue;
    if (d < 1e-3) return flag;
    const cos = (dx * view.x + dy * view.y + dz * view.z) / d;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const reach = Math.max(rules.orderConeRad, Math.atan2(Number.isFinite(flag.radius) ? flag.radius : 20, d));
    if (angle > reach) continue;
    // Nearly in line (a near flag before a far one): the nearer flag wins.
    const score = angle / reach + rules.orderNearBias * (d / rules.orderRange);
    if (score < bestScore) { bestScore = score; best = flag; }
  }
  return best;
}

/**
 * Player row field `cqc` (Conquest only, present only while the player has a
 * live request): [seq, kindIndex, responderId | null, vehicleId?]. The marker
 * stands at the requester's own row (its downed body while down), or at the
 * hull named by vehicleId (NEED REPAIR). The responder is null until a bot
 * answered. Requests never ride `match.conquest`, which keeps its 400 B budget.
 */
export function encodeCommField(request) {
  const row = [request.seq | 0, COMM_KINDS.indexOf(request.kind), request.responder == null ? null : String(request.responder)];
  if (request.vehicleId != null) row.push(String(request.vehicleId));
  return row;
}

export function decodeCommField(row) {
  const cqc = Array.isArray(row?.cqc) ? row.cqc : null;
  const kind = cqc ? COMM_KINDS[cqc[1]] : null;
  if (!COMM_REQUESTS.includes(kind)) return null;
  return { seq: cqc[0] | 0, kind, responder: cqc[2] == null ? null : String(cqc[2]), vehicleId: cqc[3] == null ? null : String(cqc[3]) };
}

/**
 * Every live request from snapshot rows: {seq, kind, by, team, x, y, z,
 * responder, vehicleId}. `vehicles` are vehicle rows (id, x, y, z); a repair
 * request whose hull is not in them stands at the requester.
 */
export function commRequestsOf(players, vehicles = []) {
  const out = [];
  const hulls = new Map((Array.isArray(vehicles) ? vehicles : []).map(v => [String(v?.id), v]));
  for (const p of Array.isArray(players) ? players : []) {
    const comm = decodeCommField(p);
    if (!comm) continue;
    const at = (comm.vehicleId && hulls.get(comm.vehicleId)) || p;
    if (![at.x, at.y, at.z].every(Number.isFinite)) continue;
    out.push({ ...comm, by: String(p.id), team: p.team ?? null, x: at.x, y: at.y, z: at.z });
  }
  return out.sort((a, b) => a.seq - b.seq);
}
