// Bots and the comeback call-in (docs/conquest.md "Comeback call-in"; the
// server half is server/modes/conquest/map-events/comeback.js). Pure picks
// over the policy's live state, called by the controller once a second
// while the call-in waits for a target:
//
//   target    the enemy-held or contested flag (an active one in Breakthrough)
//             with the most living enemies on foot or in ground hulls within
//             its radius plus `flagPad`; ties go to the flag nearer the own
//             HQ (the front). The aim point is those enemies' centroid, so
//             the strike lands on the crowd rather than the flag pole. No
//             flag with an enemy on it: no call yet (the next check retries).
//   kind      a bomber run when `bomberHulls` enemy ground hulls stand within
//             `hullRadius` of the aim point (the bomb line covers a convoy),
//             else the artillery barrage (infantry spread over a flag zone).
//   caller    the team's bot squad leader nearest the aim point, else any
//             living bot of the team (a side whose squads all have human
//             leaders still gets its call after their grace), else nobody.
//
// The target side's bots run out of the strike zone through the framework's
// hazard avoidance (server/bot-map-events.js); the caller's side follows the
// strike up with an attack task on the target (the controller's botTasks).
import { COMEBACK_TUNING, comebackTargetRefusal } from '../shared/map-events/comeback.js';
import { isAircraft } from '../shared/vehicles.js';

const other = team => (team === 'alpha' ? 'bravo' : 'alpha');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Living members of `team` (bots and humans) as entities. */
function members(policy, team) {
  const out = [];
  for (const e of policy.engine?.combatants?.values?.() ?? []) if (e.state === 'alive' && policy.teamFor(e) === team) out.push(e);
  return out;
}

/**
 * The commander's call: `{kind, x, z, by, flag}` or null. `policy` is the
 * ConquestPolicy (flags, capture locks, squads, engine), `team` the side
 * holding the call-in.
 */
export function planComebackCall(policy, team, tuning = COMEBACK_TUNING) {
  const enemy = other(team), meta = policy.mapMeta?.conquest ?? null;
  const base = meta?.bases?.[team] ?? null;
  const hostiles = members(policy, enemy).filter(e => {
    const hull = e.vehicleId ? policy.vehicleFor(e.vehicleId) : null;
    return !(hull && isAircraft(hull.type) && hull.grounded === false);
  });
  let best = null;
  for (const flag of policy.flags ?? []) {
    if (policy.capture?.locked?.(flag)) continue;
    const contested = flag.state === 'contested' || flag.state === 'neutralizing' || flag.state === 'capturing';
    if (flag.owner !== enemy && !contested) continue;
    const near = hostiles.filter(e => flat(e, flag) <= (flag.radius ?? 20) + tuning.bot.flagPad);
    if (!near.length) continue;
    const front = base ? flat(flag, base) : 0;
    if (!best || near.length > best.near.length || (near.length === best.near.length && front < best.front)) best = { flag, near, front };
  }
  if (!best) return null;
  let x = best.near.reduce((s, e) => s + e.x, 0) / best.near.length, z = best.near.reduce((s, e) => s + e.z, 0) / best.near.length;
  if (comebackTargetRefusal(meta, x, z, tuning.designate)) { x = best.flag.x; z = best.flag.z; }
  if (comebackTargetRefusal(meta, x, z, tuning.designate)) return null;
  const aim = { x, z };
  let hulls = 0;
  for (const hull of policy.engine?.vehicles?.vehicles?.values?.() ?? []) {
    if (hull.team === enemy && hull.hp > 0 && !isAircraft(hull.type) && flat(hull, aim) <= tuning.bot.hullRadius) hulls++;
  }
  const kind = hulls >= tuning.bot.bomberHulls ? 'bomber' : 'artillery';
  const squads = policy.squads?.map?.() ?? new Map();
  const bots = members(policy, team).filter(e => e.bot);
  const leaders = bots.filter(e => squads.get(String(e.id))?.leaderId === String(e.id));
  const pool = leaders.length ? leaders : bots;
  if (!pool.length) return null;
  pool.sort((p, q) => flat(p, aim) - flat(q, aim));
  return { kind, x: Math.round(x), z: Math.round(z), by: pool[0], flag: best.flag.id };
}

/** True when a human leads one of `team`'s squads (they get the grace to call it themselves). */
export function humanLeadsSquad(policy, team) {
  for (const [id, row] of policy.squads?.map?.() ?? []) {
    if (row.team !== team || row.leaderId !== id) continue;
    const e = policy.engine?.combatants?.get?.(String(id)) ?? null;
    if (e && !e.bot) return true;
  }
  return false;
}
