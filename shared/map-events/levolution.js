// Levolutions: structures a Conquest side can blow down for the rest of the
// round (docs/conquest.md "Map events", "Levolutions"). The Iron Bridge
// collapse was the first (shared/conquest-bridge.js); its stage machine is the
// generic one (server/modes/conquest/map-events/levolution.js), so any span,
// trestle or sluice is data: a definition built with `defineLevolution`.
//
//   intact  -> damaged   the pool at or below `damagedAt`         (phase armed)
//   damaged -> failing   the pool at 0: the groan, `warnMs`       (phase warning)
//                        the crossing closes for bot drivers
//   failing -> down      the span is brought down through the     (phase active,
//                        structural system, bodies on it crushed   then done)
//
// Pure data and helpers shared by the server, the bots and the client.
import { IRON_BRIDGE_RULES } from '../conquest-bridge.js';
import { defineMapEvent } from './define.js';

/** Stage order (the Iron Bridge's BRIDGE_STAGES); a levolution event's phase maps onto it. */
export const LEVOLUTION_STAGES = Object.freeze(['intact', 'damaged', 'failing', 'down']);
export const LEVOLUTION_STAGE = Object.freeze({ intact: 0, damaged: 1, failing: 2, down: 3 });
const PHASE_STAGE = Object.freeze({ idle: 0, armed: 1, warning: 2, active: 3, done: 3, cooldown: 3 });

/** The stage of a levolution event in `phase` (an idle row is intact). */
export const levolutionStage = phase => PHASE_STAGE[phase] ?? 0;

/**
 * Stage-machine defaults: the Iron Bridge's numbers (IRON_BRIDGE_RULES). A
 * definition overrides any of them in `rules`; the integrity pool itself is
 * the definition's target (`integrity`, blasts by IRON_BRIDGE_RULES.supportDamage).
 *  damagedAt   remaining share at or below which the structure is damaged
 *  warnMs      the groan between 0 and the fall (the span still carries traffic)
 *  chunkCap    doomed blocks fall as at most this many chunks
 *  spanCrush   bodies on the span as it drops: infantry damage, the hull share
 *              of max HP, and the band `above` the deck that counts as on it
 *  downMs      how long the `active` phase (the fall) lasts before `done`
 */
export const LEVOLUTION_RULES = Object.freeze({
  damagedAt: IRON_BRIDGE_RULES.damagedAt,
  warnMs: IRON_BRIDGE_RULES.warnMs,
  chunkCap: IRON_BRIDGE_RULES.chunkCap,
  spanCrush: IRON_BRIDGE_RULES.spanCrush,
  downMs: 6000,
});

const box = b => Object.freeze({ x0: b.x0, y0: b.y0, z0: b.z0, x1: b.x1, y1: b.y1, z1: b.z1 });
const point = p => Object.freeze({ x: p.x, y: p.y, z: p.z });

/**
 * One levolution as a map event definition (defineMapEvent with kind
 * `levolution`, the stage machine's durations and the structure in `tuning`):
 *
 *   id, maps, name, short, glyph, flag, anchor, texts, cues, breakthrough  as defineMapEvent
 *   crossing    the road crossing id (mapMeta.conquest.crossings) closed from the groan on
 *   integrity   the support pool (rockets 100, tank HE 120, a bomb 420, an AT mine 150 ...)
 *   supports    [{id, x0..z1}] the boxes blasts are measured against (the bots aim at them)
 *   span        [{x0..z1}] everything that falls (one box or several)
 *   materials   optional [block id]: only these blocks of the span boxes fall
 *               (a trestle's plank, steel and rust; the canyon walls inside stay)
 *   deckY       the deck's top block row (crush band, FX, the HUD's stripes)
 *   waterY      optional: only span columns over water in the pristine map fall
 *               (the rest keeps a ledge on the bank)
 *   sinks       optional [{x0..z1}]: concrete under the water turns to water
 *               first (the Iron Bridge's pier stumps)
 *   heads       [{x, y, z}] the bridgeheads either side (bots hold them; the fall
 *               never takes them)
 *   axis        'x' | 'z': the direction traffic crosses the span (HUD break marks)
 *   fall        optional StructureSystem.bringDown `fall` (a directed topple)
 *   rules       stage-machine overrides of LEVOLUTION_RULES
 *   detect      optional [x, y, z]: a block that must be solid at the round start
 *               (a world without it keeps the event inert); default the anchor's deck cell
 */
export function defineLevolution(spec) {
  const rules = Object.freeze({ ...LEVOLUTION_RULES, ...(spec.rules ?? {}) });
  const spans = (Array.isArray(spec.span) ? spec.span : [spec.span]).filter(Boolean).map(box);
  if (!spans.length) throw new Error(`levolution ${spec.id}: needs a span`);
  if (!(spec.supports?.length)) throw new Error(`levolution ${spec.id}: needs supports`);
  const structure = Object.freeze({
    id: spec.id, crossing: spec.crossing ?? null, deckY: spec.deckY,
    waterY: Number.isFinite(spec.waterY) ? spec.waterY : null,
    span: Object.freeze(spans), sinks: Object.freeze((spec.sinks ?? []).map(box)),
    supports: Object.freeze(spec.supports.map(s => Object.freeze({ id: s.id, ...box(s) }))),
    heads: Object.freeze((spec.heads ?? []).map(point)), axis: spec.axis === 'z' ? 'z' : 'x',
    fall: spec.fall ? Object.freeze({ ...spec.fall }) : null,
    detect: Array.isArray(spec.detect) ? Object.freeze([...spec.detect]) : null,
    materials: Array.isArray(spec.materials) && spec.materials.length ? Object.freeze([...spec.materials]) : null,
  });
  return defineMapEvent({
    id: spec.id, maps: spec.maps, kind: 'levolution', name: spec.name, short: spec.short, glyph: spec.glyph ?? 'collapse',
    texts: spec.texts ?? {
      armed: { title: 'DAMAGED', detail: 'SUPPORTS HOLDING' },
      warning: { title: 'COLLAPSING', detail: 'GET OFF THE SPAN', countdown: 'FALLS IN' },
      active: { title: 'DESTROYED', detail: 'VEHICLES CROSS ELSEWHERE' },
    },
    cues: spec.cues, anchor: spec.anchor, flag: spec.flag ?? null, big: spec.big !== false, breakthrough: spec.breakthrough,
    durations: { armedMs: null, warningMs: rules.warnMs, activeMs: rules.downMs },
    targets: [{ id: 'supports', boxes: structure.supports, integrity: spec.integrity,
      ...(spec.supportDamage ? { supportDamage: spec.supportDamage } : {}), ...(Number.isFinite(spec.minReach) ? { minReach: spec.minReach } : {}) }],
    killKeys: spec.killKeys ?? {},
    tuning: { ...(spec.tuning ?? {}), levolution: Object.freeze({ structure, rules }) },
  });
}

/** True when a world point lies over a span box's footprint, from its bottom to `above` m over the deck. */
export function onLevolutionSpan(structure, x, y, z, above = LEVOLUTION_RULES.spanCrush.above) {
  for (const s of structure.span) {
    if (x >= s.x0 && x < s.x1 + 1 && z >= s.z0 && z < s.z1 + 1 && y >= s.y0 && y <= structure.deckY + 1 + above) return true;
  }
  return false;
}

/** The footprint {x0, z0, x1, z1} (exclusive upper edges) around every span box. */
export function levolutionFootprint(structure) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of structure.span) { x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1 + 1); z1 = Math.max(z1, s.z1 + 1); }
  return { x0, z0, x1, z1 };
}
