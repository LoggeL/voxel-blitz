// Comeback call-in (docs/conquest.md "Map events" / "Comeback call-in"): a
// team that trails by a clear ticket deficit for a sustained time earns one
// call-in per round. Its squad leaders (humans on the full map, bot leaders
// through the commander's pick) designate a target and choose a BOMBER RUN
// (a visual-only jet carpets a line of bombs over it) or an ARTILLERY
// barrage (shells over 10 s in a 25 m circle). The target gets a 5 s
// telegraph, then real projectiles land (ProjectileSystem, credited to the
// designator under this event's kill keys).
//
// Phases: idle (the server watches the deficit) -> armed (CALL-IN READY for
// `team`, open until a leader designates) -> warning (the telegraph) ->
// active (the strike) -> cooldown -> idle, so the other side can still earn
// its own call-in; each side at most once a round (`repeat.max` 2).
//
// Wire (`match.conquest.ev` row): progress 0, `team` the side that called it,
// `extra` [kind, headingDeg] (kind 1 bomber, 2 artillery; 0 while ready) and
// the target as the runtime anchor x / z. Pure helpers below are shared by
// the server, the bots, the HUD and the tests.
import { defineMapEvent } from './define.js';
import { mulberry32 } from '../noise.js';

/** Strike kinds; `extra[0]` on the wire is the 1-based index (0: none chosen yet). */
export const COMEBACK_KINDS = Object.freeze(['bomber', 'artillery']);
export const comebackKindCode = kind => COMEBACK_KINDS.indexOf(kind) + 1;
export const comebackKindOf = code => COMEBACK_KINDS[(code | 0) - 1] ?? null;

export const COMEBACK_EVENT = defineMapEvent({
  id: 'comeback',
  maps: ['frontier', 'redrock'],
  kind: 'callin',
  name: 'Call-in',
  short: 'CALL-IN',
  glyph: 'callin',
  anchor: null,
  flag: null,
  // A call-in is a squad's answer to a losing fight: it never waits behind another event's window.
  big: false,
  // Once per side a round: the trailing side's fire, then (if the tide turns) the other side's.
  repeat: { cooldownMs: 3000, max: 2 },
  breakthrough: true,
  durations: { armedMs: null, warningMs: 5000, activeMs: null },
  texts: {
    // READY is the caller's side only (the presenter drops it for the other side: the telegraph is their warning).
    armed: { title: 'READY', detail: 'SQUAD LEADERS · MARK A TARGET ON THE MAP (M)' },
    warning: { title: 'INBOUND', countdown: 'IMPACT IN', own: { title: 'INBOUND', detail: 'FRIENDLY STRIKE ON THE MARKED TARGET' },
      enemy: { title: 'INCOMING', detail: 'RED SMOKE · GET OUT OF THE TARGET AREA' } },
    active: { title: 'IMPACT', own: { title: 'ON TARGET' }, enemy: { title: 'IMPACT', detail: 'TAKE COVER' } },
  },
  killKeys: {
    callinBomb: { label: 'BOMBER RUN', icon: 'bomb' },
    callinShell: { label: 'ARTILLERY', icon: 'mortar' },
  },
  // The alarm stinger as it warns (both sides; READY stays silent so the other side hears nothing of it).
  cues: {
    warning: { stinger: 'ticket_low', own: null, enemy: null, any: null },
    active: { stinger: null, own: null, enemy: null, any: null },
  },
  tuning: {
    /**
     * Earning (plain Conquest): a side at least max(deficitShare x start
     * tickets, deficitMin) tickets behind for sustainMs in a row. With 300
     * tickets: 75 behind for 20 s.
     */
    earn: { deficitShare: 0.25, deficitMin: 60, sustainMs: 20000 },
    /**
     * Breakthrough (only the attackers have tickets): the attackers earn it
     * at or below attackerShare of their start pool (10 of 30), outside
     * overtime; the defenders once the attackers stand on the last sector.
     * Both held for sustainMs.
     */
    breakthrough: { attackerShare: 0.35, defenderLastSector: true, sustainMs: 20000 },
    /**
     * Designation: humans get humanGraceMs from READY before a bot leader
     * calls it in (botDelayMs when no human leads a squad of the side);
     * targets keep edgeMargin m inside the combat area and hqPad m off
     * either HQ's restricted circle.
     */
    designate: { humanGraceMs: 20000, botDelayMs: 4000, edgeMargin: 8, hqPad: 10 },
    /** Bot pick: a bomber run when at least this many enemy ground hulls stand within hullRadius of the flag. */
    bot: { bomberHulls: 1, hullRadius: 45, flagPad: 15 },
    /**
     * Bomber run: `bombs` along the heading from the caller's HQ over the
     * target, `spacing` m apart, released from `altitude` m over the target
     * ground at `speed` m/s (the visual jet's pass), the first impact
     * `firstImpactMs` after the warning. Blast numbers override the jet
     * bomb's (no ground fire): `damage` splash over `damageRadius`,
     * `directDamage` on a direct hit, the crater `terrainRadius`.
     */
    bomber: { bombs: 7, spacing: 9, altitude: 48, speed: 90, firstImpactMs: 600, weapon: 'jetBomb', killKey: 'callinBomb',
      blast: { damage: 210, directDamage: 250, damageRadius: 9, knockback: 24, terrainRadius: 3, terrainPower: 230, maxDestroyedBlocks: 80 },
      /** Visual approach: the jet appears this far before its first release and flies on as far after the last. */
      approachM: 520, zoneWidth: 11 },
    /**
     * Artillery: `shells` over `spanMs` (the first `firstImpactMs` after the
     * warning, then evenly spaced with +-jitterMs) at seeded points inside
     * `radius` m, each falling for `flightMs` from `riseM` up and `backM`
     * toward the caller's HQ (the mortar round's presentation and whistle).
     */
    artillery: { shells: 12, spanMs: 10000, firstImpactMs: 500, jitterMs: 250, radius: 25, flightMs: 3000, riseM: 140, backM: 40,
      weapon: 'mortarHE', killKey: 'callinShell',
      blast: { damage: 180, directDamage: 200, damageRadius: 8, knockback: 18, terrainRadius: 2.4, terrainPower: 170, maxDestroyedBlocks: 34 } },
    /** The active phase runs this long past the last planned impact (stragglers, chained blasts). */
    tailMs: 1500,
    /** Red smoke at the target through the warning (presentation; the HUD and FX read it from here). */
    smoke: { color: [0.95, 0.12, 0.08], rate: 26 },
  },
});

export const COMEBACK_TUNING = COMEBACK_EVENT.tuning;

/* ------------------------------------------------------------------ rules */

/**
 * The plain Conquest side that has earned the call-in condition now (it
 * trails by enough), or null. `tickets` {alpha, bravo}, `max` the start pool.
 */
export function comebackTrailingTeam(tickets, max, earn = COMEBACK_TUNING.earn) {
  const a = Number(tickets?.alpha), b = Number(tickets?.bravo);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const need = Math.max(earn.deficitShare * Math.max(1, max || 1), earn.deficitMin);
  if (b - a >= need) return 'alpha';
  if (a - b >= need) return 'bravo';
  return null;
}

/**
 * Breakthrough: the sides meeting their condition now. `bt` {attackers,
 * defenders, tickets (attackers'), max, sector, sectors, overtime}.
 */
export function comebackBreakthroughTeams(bt, rules = COMEBACK_TUNING.breakthrough) {
  const out = [];
  if (!bt) return out;
  if (!bt.overtime && Number.isFinite(bt.tickets) && bt.tickets <= Math.floor(rules.attackerShare * Math.max(1, bt.max || 1))) out.push(bt.attackers);
  if (rules.defenderLastSector && bt.sectors > 1 && bt.sector === bt.sectors - 1) out.push(bt.defenders);
  return out;
}

/** `use` intent target id of a designation (at most 64 chars): `comeback:call:<kind>:<x>:<z>`. */
export const comebackCallKey = (kind, x, z) => `comeback:call:${comebackKindCode(kind)}:${Math.round(x)}:${Math.round(z)}`;

/** Parse the part after `comeback:` of a designation key: {kind, x, z} or null. */
export function parseComebackCall(rest) {
  const m = /^call:([12]):(-?\d{1,4}):(-?\d{1,4})$/.exec(String(rest ?? ''));
  return m ? { kind: comebackKindOf(Number(m[1])), x: Number(m[2]), z: Number(m[3]) } : null;
}

/**
 * Why a target is refused (`'area'` outside the combat area margin, `'hq'`
 * inside either HQ's circle plus the pad), or null. `meta` is
 * mapMeta.conquest (combatArea, bases).
 */
export function comebackTargetRefusal(meta, x, z, designate = COMEBACK_TUNING.designate) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'area';
  const area = meta?.combatArea, m = designate.edgeMargin;
  if (area && (x < area.minX + m || x > area.maxX - m || z < area.minZ + m || z > area.maxZ - m)) return 'area';
  for (const base of Object.values(meta?.bases ?? {})) {
    if (Number.isFinite(base?.x) && Math.hypot(x - base.x, z - base.z) < (base.radius ?? 0) + designate.hqPad) return 'hq';
  }
  return null;
}

/**
 * Bomber heading in whole degrees (0 = north / -z, 90 = east / +x, as the
 * compass) from the caller's HQ to the target, so the jet comes in over its
 * own lines. Falls back to the map centre axis.
 */
export function comebackHeadingDeg(meta, team, target) {
  const base = meta?.bases?.[team];
  const from = Number.isFinite(base?.x) ? base : { x: 384, z: team === 'bravo' ? 384 + 1 : 384 - 1 };
  let dx = target.x - from.x, dz = target.z - from.z;
  if (Math.hypot(dx, dz) < 1) { dx = team === 'bravo' ? -1 : 1; dz = 0; }
  const deg = Math.round(Math.atan2(dx, -dz) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

/** Flat unit vector of a compass heading. */
export const headingVector = deg => ({ x: Math.sin(deg * Math.PI / 180), z: -Math.cos(deg * Math.PI / 180) });

/**
 * The strike's deterministic plan: `drops` [{x, z, atMs}] (impact points,
 * ms after the warning ends), `activeMs` (the active phase), the bomber's
 * line `a` -> `b` and the hazard `zone` (shared geometry: a capsule along
 * the bomb line, or the barrage circle).
 */
export function comebackStrikePlan({ kind, target, headingDeg = 90, seed = 1, tuning = COMEBACK_TUNING }) {
  if (kind === 'bomber') {
    const t = tuning.bomber, dir = headingVector(headingDeg), half = (t.bombs - 1) * t.spacing / 2;
    const drops = [];
    for (let i = 0; i < t.bombs; i++) {
      const s = -half + i * t.spacing;
      drops.push({ x: target.x + dir.x * s, z: target.z + dir.z * s, atMs: Math.round(t.firstImpactMs + i * t.spacing / t.speed * 1000) });
    }
    const a = { x: target.x - dir.x * half, z: target.z - dir.z * half }, b = { x: target.x + dir.x * half, z: target.z + dir.z * half };
    return { kind, drops, a, b, dir, activeMs: drops.at(-1).atMs + tuning.tailMs,
      zone: { shape: 'line', ax: a.x, az: a.z, bx: b.x, bz: b.z, w: t.zoneWidth } };
  }
  const t = tuning.artillery, rng = mulberry32((seed >>> 0) ^ 0xA27111E);
  const step = t.shells > 1 ? (t.spanMs - t.firstImpactMs) / (t.shells - 1) : 0;
  const drops = [];
  for (let i = 0; i < t.shells; i++) {
    const r = t.radius * Math.sqrt(rng()), a = rng() * Math.PI * 2, jitter = (rng() * 2 - 1) * t.jitterMs;
    drops.push({ x: target.x + Math.cos(a) * r, z: target.z + Math.sin(a) * r, atMs: Math.max(0, Math.round(t.firstImpactMs + i * step + (i ? jitter : 0))) });
  }
  drops.sort((p, q) => p.atMs - q.atMs);
  return { kind, drops, activeMs: drops.at(-1).atMs + tuning.tailMs, dir: headingVector(headingDeg),
    zone: { shape: 'circle', x: target.x, z: target.z, r: t.radius + 4 } };
}

/** The hazard / map zone of a decoded `ev` row (null while ready). */
export function comebackZoneOf(event) {
  const kind = comebackKindOf(event?.extra?.[0]);
  const a = event?.anchor;
  if (!kind || !a || !Number.isFinite(a.x)) return null;
  return comebackStrikePlan({ kind, target: a, headingDeg: Number(event.extra[1]) || 0 });
}
