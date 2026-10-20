// Iron Bridge collapse (Conquest "levolution" on Frontier, docs/conquest.md
// "Iron Bridge collapse"). Pure data and helpers shared by the server
// (server/modes/conquest/bridge.js), the bots and the client presentation.
//
// The bowstring truss over flag C (shared/world/frontier-sites/bridge.js)
// stands on two kinds of support: the mid-river piers under the deck and the
// four concrete truss feet on the banks. Explosions near them wear down one
// integrity pool; at zero the bridge groans for `warnMs`, then every block of
// the span (deck, girders and the truss between the banks) is doomed through
// the structural system and falls into the river as chunks. The truss stubs
// over the banks keep standing.

import { FRONTIER_PLAN } from './conquest-contract.js';

const CROSSING = FRONTIER_PLAN.crossings.find(c => c.id === 'iron-bridge');
const RIVER_HALF = FRONTIER_PLAN.river.width / 2;
const DECK_Y = FRONTIER_PLAN.heights.valleyMin + 1;

/** Bowstring truss over the C deck: arch feet x0/x1, the two truss planes zs, arch rise over the deck. */
export const IRON_ARCH = Object.freeze({ x0: 366, x1: 401, zs: Object.freeze([378, 389]), rise: 19 });

const box = (x0, y0, z0, x1, y1, z1) => Object.freeze({ x0, y0, z0, x1, y1, z1 });

/**
 * Geometry (integer voxel boxes, inclusive). `span` is everything that falls:
 * the deck cells over the 20 m channel, the edge girders and the truss planes
 * between the banks, from just above the water to above the arch crown.
 * `piers` lists the mid-river pier columns (their parts below the water
 * surface turn into river water when the span goes). `supports` are the boxes
 * blasts are measured against.
 */
export const IRON_BRIDGE = Object.freeze({
  id: 'iron-bridge',
  flag: 'C',
  crossing: CROSSING.id,
  x: CROSSING.x, z: CROSSING.z,
  deckY: DECK_Y,
  waterY: FRONTIER_PLAN.heights.waterSurface,
  span: box(CROSSING.x - RIVER_HALF, FRONTIER_PLAN.heights.waterSurface + 1, IRON_ARCH.zs[0],
    CROSSING.x + RIVER_HALF - 1, DECK_Y + 1 + IRON_ARCH.rise + 2, IRON_ARCH.zs[1]),
  piers: box(CROSSING.x - 1, 1, IRON_ARCH.zs[0] + 1, CROSSING.x, DECK_Y - 2, IRON_ARCH.zs[1] - 1),
  supports: Object.freeze([
    Object.freeze({ id: 'piers', ...box(CROSSING.x - 1, FRONTIER_PLAN.heights.waterSurface - 2, IRON_ARCH.zs[0] + 1, CROSSING.x, DECK_Y - 2, IRON_ARCH.zs[1] - 1) }),
    ...IRON_ARCH.zs.flatMap(z => [IRON_ARCH.x0, IRON_ARCH.x1].map(x => Object.freeze({
      id: `foot-${x < CROSSING.x ? 'w' : 'e'}${z < CROSSING.z ? 'n' : 's'}`, ...box(x - 1, DECK_Y - 3, z - 1, x + 1, DECK_Y + 1, z + 1) }))),
  ]),
});

/**
 * Tuning. Integrity is one pool for all supports. A blast within
 * max(its damage radius, minReach) of a support box deals its
 * `supportDamage` entry (by weapon key) scaled linearly down to 0 at that
 * reach; the nearest support counts, never several. Keys not listed (bullets,
 * smoke, molotov, pulse, bubbles, the chin cannon) do nothing. `limpet` is
 * the projectile type of the wall claymore. With 1000 integrity: 10 RX-8 or
 * TOW/guided missile hits, about 8 tank HE or 15 AP shells, 3 jet bombs,
 * 25 mortar bombs or 250 flak shells.
 */
export const IRON_BRIDGE_RULES = Object.freeze({
  integrity: 1000,
  /** Integrity share at or below which the bridge is `damaged` (event, HUD warning). */
  damagedAt: 0.5,
  /** Groan between integrity 0 and the fall (the span still carries traffic). */
  warnMs: 3500,
  /** Minimum blast reach to a support box, m. */
  minReach: 1.5,
  supportDamage: Object.freeze({
    rocket: 100, guidedMissile: 100, towMissile: 100, tankAP: 65, tankHE: 120, jetBomb: 420,
    helicopterRocket: 30, atmine: 150, limpet: 10, mgl: 25, frag: 15,
    // The Support's M-81 mortar (a plunging HE bomb with a small charge: 25
    // rounds, five magazines) and the mobile AA's 35 mm flak (a small fused
    // shell at 8 rounds/s: 250 hits, half a minute of fire on one support).
    mortarHE: 40, flak35: 4,
  }),
  /** Bodies standing on the span when it goes: infantry damage and hull share of max HP (kill key `collapse`). */
  spanCrush: Object.freeze({ infantry: 45, hullFraction: 0.2, above: 4 }),
  /** Score reason paid to whoever dealt the final blow. */
  scoreReason: 'bridge_destroyed',
  /** Doomed span blocks may fall as this many chunks (the structural default is 12). */
  chunkCap: 16,
});

/** Stage order on the wire (`match.conquest.br[0]` and the `bridge` event). */
export const BRIDGE_STAGES = Object.freeze(['intact', 'damaged', 'failing', 'down']);
export const BRIDGE_STAGE = Object.freeze({ intact: 0, damaged: 1, failing: 2, down: 3 });

export const insideBox = (b, x, y, z) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

/** Distance (m) from a point to an inclusive voxel box (0 inside). */
export function boxDistance(b, x, y, z) {
  const dx = Math.max(b.x0 - x, 0, x - (b.x1 + 1));
  const dy = Math.max(b.y0 - y, 0, y - (b.y1 + 1));
  const dz = Math.max(b.z0 - z, 0, z - (b.z1 + 1));
  return Math.hypot(dx, dy, dz);
}

/** Integrity a blast takes off the bridge: `{ damage, support }` (damage 0 out of reach or for an inert key). */
export function bridgeBlastDamage(origin, key, radius = 0, rules = IRON_BRIDGE_RULES, bridge = IRON_BRIDGE) {
  const base = rules.supportDamage[key] ?? 0;
  if (!(base > 0) || !Array.isArray(origin) || !origin.every(Number.isFinite)) return { damage: 0, support: null };
  const reach = Math.max(Number.isFinite(radius) ? radius : 0, rules.minReach);
  let best = null;
  for (const support of bridge.supports) {
    const d = boxDistance(support, origin[0], origin[1], origin[2]);
    if (d < reach && (!best || d < best.d)) best = { d, support };
  }
  if (!best) return { damage: 0, support: null };
  return { damage: base * (1 - best.d / reach), support: best.support.id };
}

/** True when a world point (feet or block) lies over the span footprint, from the water up to `above` m over the deck. */
export function onBridgeSpan(x, y, z, { above = IRON_BRIDGE_RULES.spanCrush.above, bridge = IRON_BRIDGE } = {}) {
  const s = bridge.span;
  return x >= s.x0 && x < s.x1 + 1 && z >= s.z0 && z < s.z1 + 1 && y >= s.y0 && y <= bridge.deckY + 1 + above;
}

/** True when the segment a-b (x/z) crosses the span footprint grown by `pad` m: a straight drive over the gap. */
export function crossesBridgeSpan(a, b, pad = 2, bridge = IRON_BRIDGE) {
  const s = bridge.span, x0 = s.x0 - pad, x1 = s.x1 + 1 + pad, z0 = s.z0 - pad, z1 = s.z1 + 1 + pad;
  // Liang-Barsky clip of the segment against the footprint.
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}

/** `match.conquest.br` = [stage, integrity100, fallAt?] (absent while intact and undamaged). */
export function encodeBridge(state) {
  if (!state || (state.stage === 0 && state.integrity >= 1)) return null;
  const row = [state.stage | 0, Math.max(0, Math.min(100, Math.round(state.integrity * 100)))];
  if (state.stage === BRIDGE_STAGE.failing && Number.isFinite(state.fallAt)) row.push(Math.round(state.fallAt));
  return row;
}

/** Decoded bridge state, or the intact default when `br` is absent. */
export function decodeBridge(row) {
  if (!Array.isArray(row)) return { stage: 0, name: 'intact', integrity: 1, fallAt: null };
  const stage = Math.max(0, Math.min(BRIDGE_STAGES.length - 1, row[0] | 0));
  return { stage, name: BRIDGE_STAGES[stage], integrity: Math.max(0, Math.min(1, (Number(row[1]) || 0) / 100)),
    fallAt: stage === BRIDGE_STAGE.failing && Number.isFinite(row[2]) ? row[2] : null };
}
