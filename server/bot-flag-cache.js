// Conquest bots and the flag supply caches (docs/conquest.md "Infantry
// supply" -> "Flag caches"; server/modes/conquest/flag-caches.js). A bot on
// foot that runs low (primary reserve under FLAG_CACHE_RULES.botReserveShare
// of its issue, or no bandage left under botBandageHp) walks to the cache of
// the nearest flag its side holds within botRange, when nothing urgent holds
// it: no squad all-in order and not standing in a zone its side is taking.
// It stays at the cache until it is topped up (or the run times out); the
// cache going quiet (the flag contested or lost) ends the run.
import { FLAG_CACHE_RULES } from '../shared/flag-cache.js';
import { kitLoadout } from '../shared/conquest-kits.js';

/** Topped up again: the run ends once the reserve is back over this share. */
const FULL_SHARE = 0.9;
/** ms a run may last (walk up to botRange plus a few pay ticks). */
const RUN_MS = 45000;
/** m: the walk ends this close to the cache (well inside the 4 m reach). */
const ARRIVE = 1.5;

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Primary reserve share 0..1 of the bot's issue, and its bandages, from its authoritative inventory. */
export function botSupplyState(p, loadout) {
  if (!loadout?.kit) return null;
  const issue = kitLoadout(loadout.kit, loadout.variant ?? 0, loadout.gadget ?? 0);
  const slot = issue.weapon, cap = issue.reserve[slot] || 0;
  const reserve = Math.max(0, Number(p.reserve?.[slot]) || 0);
  return { share: cap > 0 ? reserve / cap : 1, bandages: Math.max(0, Math.trunc(Number(p.medkit?.remaining) || 0)), hp: p.hp };
}

/**
 * The cache run goal of bot `p` on `team` (a commander goal), or null.
 * `runs` is the commander's Map of live runs (id -> {flagId, until}).
 */
export function flagCacheGoal(commander, p, team, { order = null, runs, now }) {
  const policy = commander.game.mode?.policy, caches = policy?.flagCaches;
  if (!caches || p.vehicleId || !runs) return null;
  const id = String(p.id), R = FLAG_CACHE_RULES;
  const state = botSupplyState(p, policy.roles?.loadoutOf?.(p));
  if (!state) return null;
  const needBandage = state.bandages === 0 && state.hp < R.botBandageHp;
  let run = runs.get(id);
  if (run && (now > run.until || (state.share >= FULL_SHARE && !needBandage))) { runs.delete(id); run = null; }
  if (!run) {
    if (state.share >= R.botReserveShare && !needBandage) return null;
    // Something urgent comes first: an all-in order, or a zone the bot's side is taking.
    if (order?.allIn) return null;
    if (policy.capture.flags.some(f => f.owner !== team && flat(f, p) <= f.radius * 0.85 && Math.abs(p.y - f.y) <= 8)) return null;
  }
  let best = null;
  for (const flag of policy.capture.flags) {
    if (!flag.cache || caches.servingTeam(flag) !== team) continue;
    if (run && run.flagId !== flag.id) continue;
    const d = flat(flag.cache, p);
    if (d > R.botRange || (best && d >= best.d)) continue;
    best = { flag, d };
  }
  if (!best) { runs.delete(id); return null; }
  if (!run) runs.set(id, run = { flagId: best.flag.id, until: now + RUN_MS });
  const { flag } = best, c = flag.cache;
  const target = { id: flag.id, x: flag.x, y: flag.y, z: flag.z, radius: flag.radius, owner: flag.owner, state: flag.state };
  const point = commander.walkablePoint?.({ x: c.x, y: c.y, z: c.z }) ?? { x: c.x, y: c.y, z: c.z };
  return { kind: 'capture', target, interact: false, stance: 'defend', role: 'supply', point, arrive: ARRIVE,
    lookYaw: Math.atan2(-(c.x - flag.x), -(c.z - flag.z)) };
}
